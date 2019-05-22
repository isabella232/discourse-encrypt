# frozen_string_literal: true

# name: discourse-encrypt
# about: Provides encrypted communication channels through Discourse.
# version: 0.1
# authors: Dan Ungureanu
# url: https://github.com/udan11/discourse-encrypt.git

enabled_site_setting :encrypt_enabled

# Register custom stylesheet.
register_asset 'stylesheets/common/encrypt.scss'
%w[clipboard exchange file-export lock times trash unlock].each { |i| register_svg_icon(i) }

# Register custom user fields to store user's key pair (public and private key)
# and passphrase salt.
DiscoursePluginRegistry.serialized_current_user_fields << 'encrypt_public_key'
DiscoursePluginRegistry.serialized_current_user_fields << 'encrypt_private_key'
DiscoursePluginRegistry.serialized_current_user_fields << 'encrypt_salt'

after_initialize do
  Rails.configuration.filter_parameters << :private_key
  Rails.configuration.filter_parameters << :salt

  module ::DiscourseEncrypt
    PLUGIN_NAME = 'discourse-encrypt'

    Store = PluginStore.new(PLUGIN_NAME)

    class Engine < ::Rails::Engine
      engine_name PLUGIN_NAME
      isolate_namespace DiscourseEncrypt
    end

    # Manages user and topic keys.
    class EncryptController < ::ApplicationController
      requires_plugin PLUGIN_NAME

      before_action :ensure_logged_in
      before_action :ensure_staff, only: :reset_user
      skip_before_action :check_xhr

      # Saves a user's key pair using custom fields.
      #
      # Params:
      # +public_key+::  Serialized public key. This parameter is optional when
      #                 the private key is updated (changed passphrase).
      # +private_key+:: Serialized private key.
      def update_keys
        public_key  = params.require(:public_key)
        private_key = params.require(:private_key)
        salt        = params.require(:salt)

        # Check if encrypt settings are visible to user.
        groups = current_user.groups.pluck(:name)
        encrypt_groups = SiteSetting.encrypt_groups.split('|')
        raise Discourse::InvalidAccess if !SiteSetting.encrypt_groups.empty? && (groups & encrypt_groups).empty?

        # Check if encryption is already enabled (but not changing passphrase).
        old_public_key = current_user.custom_fields['encrypt_public_key']
        if old_public_key && old_public_key != public_key
          return render_json_error(I18n.t('encrypt.enabled_already'), status: 409)
        end

        current_user.custom_fields['encrypt_public_key']  = public_key
        current_user.custom_fields['encrypt_private_key'] = private_key
        current_user.custom_fields['encrypt_salt']        = salt
        current_user.save_custom_fields

        render json: success_json
      end

      # Gets public keys of a set of users.
      #
      # Params:
      # +usernames+::   Array of usernames.
      #
      # Returns a hash of usernames and public keys.
      def show_user
        usernames = params.require(:usernames)

        keys = Hash[User.where(username: usernames).map { |u| [u.username, u.custom_fields['encrypt_public_key']] }]

        render json: keys
      end

      # Resets encryption keys for a user.
      #
      # Params:
      # +user_id+::   ID of user to be reset.
      def reset_user
        user_id = params.require(:user_id)

        user = User.find_by(id: user_id)
        raise Discourse::NotFound if user.blank?

        if params[:everything] == 'true'
          TopicAllowedUser
            .joins(topic: :_custom_fields)
            .where(topic_custom_fields: { name: 'encrypted_title' })
            .where(topic_allowed_users: { user_id: user.id })
            .delete_all

          PluginStoreRow
            .where(plugin_name: 'discourse-encrypt')
            .where("key LIKE 'key_%_' || ?", user.id)
            .delete_all
        end

        # Delete encryption keys.
        user.custom_fields.delete('encrypt_public_key')
        user.custom_fields.delete('encrypt_private_key')
        user.custom_fields.delete('encrypt_salt')
        user.save_custom_fields

        render json: success_json
      end
    end
  end

  add_preloaded_topic_list_custom_field('encrypted_title')
  CategoryList.preloaded_topic_custom_fields << 'encrypted_title'

  # Handle new post creation.
  add_permitted_post_create_param(:encrypted_title)
  add_permitted_post_create_param(:encrypted_raw)
  add_permitted_post_create_param(:encrypted_keys)

  NewPostManager.add_handler do |manager|
    next if !manager.args[:encrypted_raw]

    manager.args[:skip_unique_check] = true

    if encrypted_title = manager.args[:encrypted_title]
      manager.args[:topic_opts] ||= {}
      manager.args[:topic_opts][:custom_fields] ||= {}
      manager.args[:topic_opts][:custom_fields][:encrypted_title] = encrypted_title
    end

    if encrypted_raw = manager.args[:encrypted_raw]
      manager.args[:raw] = encrypted_raw
    end

    result = manager.perform_create_post
    if result.success? && encrypted_keys = manager.args[:encrypted_keys]
      keys = JSON.parse(encrypted_keys)
      topic_id = result.post.topic_id
      users = Hash[User.where(username: keys.keys).map { |u| [u.username, u] }]

      keys.each { |u, k| DiscourseEncrypt::Store.set("key_#{topic_id}_#{users[u].id}", k) }
    end

    result
  end

  module PostExtensions
    # Hide version (staff) and public version (regular users) because post
    # revisions will not be decrypted.
    def version
      is_encrypted? ? 1 : super
    end

    def public_version
      is_encrypted? ? 1 : super
    end

    def is_encrypted?
      !!(topic && topic.custom_fields && topic.custom_fields['encrypted_title'])
    end
  end

  ::Post.class_eval { prepend PostExtensions }

  module TopicsControllerExtensions
    def update
      if encrypted_title = params[:encrypted_title]
        @topic ||= Topic.find_by(id: params[:topic_id])
        guardian.ensure_can_edit!(@topic)

        @topic.custom_fields['encrypted_title'] = params.delete(:encrypted_title)
        @topic.save_custom_fields
      end

      super
    end

    def invite
      if params[:key] && params[:user]
        @topic = Topic.find_by(id: params[:topic_id])
        @user = User.find_by_username_or_email(params[:user])
        guardian.ensure_can_invite_to!(@topic)

        DiscourseEncrypt::Store.set("key_#{@topic.id}_#{@user.id}", params[:key])
      end

      super
    end

    def remove_allowed_user
      @topic ||= Topic.find_by(id: params[:topic_id])
      @user ||= User.find_by(username: params[:username])
      guardian.ensure_can_remove_allowed_users!(@topic, @user)

      DiscourseEncrypt::Store.remove("key_#{@topic.id}_#{@user.id}")

      super
    end
  end

  ::TopicsController.class_eval { prepend TopicsControllerExtensions }

  # Send plugin-specific topic data to client via serializers.
  #
  # +TopicViewSerializer+ and +BasicTopicSerializer+ should cover all topics
  # that are serialized over to the client.

  # +encrypted_title+
  #
  # Topic title encrypted with topic key.

  add_to_serializer(:topic_view, :encrypted_title, false) do
    object.topic.custom_fields['encrypted_title']
  end

  add_to_serializer(:topic_view, :include_encrypted_title?) do
    scope&.user.present? && object.topic.private_message?
  end

  add_to_serializer(:basic_topic, :encrypted_title, false) do
    object.custom_fields['encrypted_title']
  end

  add_to_serializer(:basic_topic, :include_encrypted_title?) do
    scope&.user.present? && object.private_message?
  end

  add_to_serializer(:listable_topic, :encrypted_title, false) do
    object.custom_fields['encrypted_title']
  end

  add_to_serializer(:listable_topic, :include_encrypted_title?) do
    scope&.user.present? && object.private_message?
  end

  add_to_serializer(:topic_list_item, :encrypted_title, false) do
    object.custom_fields['encrypted_title']
  end

  add_to_serializer(:topic_list_item, :include_encrypted_title?) do
    scope&.user.present? && object.private_message?
  end

  # +topic_key+
  #
  # Topic's key encrypted with user's public key.
  #
  # This value is different for every user and can be decrypted only by the
  # paired private key.

  add_to_serializer(:topic_view, :topic_key, false) do
    DiscourseEncrypt::Store.get("key_#{object.topic.id}_#{scope.user.id}")
  end

  add_to_serializer(:topic_view, :include_topic_key?) do
    scope&.user.present? && object.topic.private_message?
  end

  add_to_serializer(:basic_topic, :topic_key, false) do
    DiscourseEncrypt::Store.get("key_#{object.id}_#{scope.user.id}")
  end

  add_to_serializer(:basic_topic, :include_topic_key?) do
    scope&.user.present? && object.private_message?
  end

  add_to_serializer(:listable_topic, :topic_key, false) do
    DiscourseEncrypt::Store.get("key_#{object.id}_#{scope.user.id}")
  end

  add_to_serializer(:listable_topic, :include_topic_key?) do
    scope&.user.present? && object.private_message?
  end

  add_to_serializer(:topic_list_item, :topic_key, false) do
    DiscourseEncrypt::Store.get("key_#{object.id}_#{scope.user.id}")
  end

  add_to_serializer(:topic_list_item, :include_topic_key?) do
    scope&.user.present? && object.private_message?
  end

  DiscourseEncrypt::Engine.routes.draw do
    put  '/encrypt/keys'  => 'encrypt#update_keys'
    get  '/encrypt/user'  => 'encrypt#show_user'
    post '/encrypt/reset' => 'encrypt#reset_user'
  end

  Discourse::Application.routes.append do
    mount ::DiscourseEncrypt::Engine, at: '/'
  end
end
