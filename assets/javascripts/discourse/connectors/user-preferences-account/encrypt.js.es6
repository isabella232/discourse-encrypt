import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { registerHelper } from "discourse-common/lib/helpers";
import showModal from "discourse/lib/show-modal";
import {
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  generateSalt,
  generatePassphraseKey,
  importPrivateKey,
  importPublicKey
} from "discourse/plugins/discourse-encrypt/lib/keys";
import {
  saveKeyPairToIndexedDb,
  deleteIndexedDb
} from "discourse/plugins/discourse-encrypt/lib/keys_db";
import { hideComponentIfDisabled } from "discourse/plugins/discourse-encrypt/lib/discourse";
import {
  PACKED_KEY_HEADER,
  PACKED_KEY_SEPARATOR,
  PACKED_KEY_FOOTER
} from "discourse/plugins/discourse-encrypt/lib/discourse";

// TODO: I believe this should get into core.
// Handlebars offers `if` but no other helpers for conditions, which eventually
// lead to a lot of JavaScript bloat.
registerHelper("or", ([a, b]) => a || b);

export default {
  setupComponent(args, component) {
    const currentUser = Discourse.User.current();
    if (args.model.get("id") === currentUser.get("id")) {
      component.setProperties({
        model: args.model,
        handler: hideComponentIfDisabled(component),
        /** @var Value of passphrase input (old, current and retyped).
         *       It should stay in memory for as little time as possible.
         *       Clear it often.
         */
        oldPassphrase: "",
        passphrase: "",
        passphrase2: "",
        /** @var Whether the passphrase input is shown. */
        passphraseInput: false,
        /** @var Whether any operation (AJAX request, key generation, etc.) is
         *       in progress. */
        inProgress: false,
        /** @var Whether current user is the same as model user. */
        isCurrentUser: true,
        /** @var Whether the encryption is enabled or not. */
        isEncryptEnabled: false,
        /** @var Whether the encryption is active on this device. */
        isEncryptActive: false,
        /** @var Whether it is an import operation. */
        importKey: false,
        /** @var Key to be imported .*/
        key: "",
        // TOOD: Check out if there is a way to define functions like this in
        //       the `export default` scope.
        willDestroyElement() {
          this._super(...arguments);
          this.appEvents.off(
            "encrypt:status-changed",
            this,
            this.get("handler")
          );
        }
      });
      Ember.defineProperty(
        component,
        "passphraseStatus",
        Ember.computed("passphrase", "passphrase2", function() {
          const passphrase = component.get("passphrase");
          const passphrase2 = component.get("passphrase2");
          if (!passphrase) {
            return "encrypt.preferences.passphrase_enter";
          } else if (passphrase.length < 15) {
            return "encrypt.preferences.passphrase_insecure";
          } else if (passphrase !== passphrase2) {
            return "encrypt.preferences.passphrase_mismatch";
          }
        })
      );
    } else {
      component.setProperties({
        model: args.model,
        isCurrentUser: false,
        isEncryptEnabled: !!args.model.get("custom_fields.encrypt_public_key")
      });
    }
  },

  actions: {
    showPassphraseInput() {
      this.setProperties({
        passphrase: "",
        passphrase2: "",
        oldPassphrase: "",
        passphraseInput: true
      });
    },

    hidePassphraseInput() {
      this.setProperties({
        passphrase: "",
        passphrase2: "",
        oldPassphrase: "",
        passphraseInput: false
      });
    },

    enableEncrypt() {
      this.set("inProgress", true);

      // 1. Generate new key pair or import existing one.
      let keyPairPromise;
      if (this.get("importKey")) {
        const str = (this.get("key") || PACKED_KEY_SEPARATOR)
          .replace(PACKED_KEY_HEADER, "")
          .replace(PACKED_KEY_FOOTER, "")
          .split(PACKED_KEY_SEPARATOR);

        const publicStr = str[0]
          .split(/\s+/)
          .map(x => x.trim())
          .join("");
        const privateStr = str[1]
          .split(/\s+/)
          .map(x => x.trim())
          .join("");

        keyPairPromise = Promise.all([
          importPublicKey(publicStr),
          importPublicKey(privateStr, ["decrypt", "unwrapKey"])
        ]);
      } else {
        keyPairPromise = generateKeyPair();
      }

      // 2. a. Export public key to string.
      // 2. b. Export private key to a string (using passphrase).
      keyPairPromise
        .then(keyPair => {
          const [publicKey, privateKey] = keyPair;

          const passphrase = this.get("passphrase");
          const salt = generateSalt();
          const publicStr = exportPublicKey(publicKey);
          const privateStr = generatePassphraseKey(passphrase, salt).then(
            passphraseKey => exportPrivateKey(privateKey, passphraseKey)
          );

          return Ember.RSVP.Promise.all([publicStr, privateStr, salt]);
        })

        // 3. Save keys to server.
        .then(([publicStr, privateStr, salt]) => {
          this.set("model.custom_fields.encrypt_public_key", publicStr);
          this.set("model.custom_fields.encrypt_private_key", privateStr);
          this.set("model.custom_fields.encrypt_salt", salt);
          const saveKeys = ajax("/encrypt/keys", {
            type: "PUT",
            data: { public_key: publicStr, private_key: privateStr, salt }
          });

          return Ember.RSVP.Promise.all([
            publicStr,
            privateStr,
            salt,
            saveKeys
          ]);
        })

        // 4. Re-import keys but this time as `unextractable`.
        .then(([publicStr, privateStr, salt]) =>
          Ember.RSVP.Promise.all([
            importPublicKey(publicStr),
            generatePassphraseKey(this.get("passphrase"), salt).then(
              passphraseKey => importPrivateKey(privateStr, passphraseKey)
            )
          ])
        )

        // 5. Save key pair in local IndexedDb.
        .then(([publicKey, privateKey]) =>
          saveKeyPairToIndexedDb(publicKey, privateKey)
        )

        // 6. Reset component status.
        .then(() => {
          this.appEvents.trigger("encrypt:status-changed");

          this.send("hidePassphraseInput");
          this.setProperties({
            inProgress: false,
            isEncryptEnabled: true,
            isEncryptActive: true,
            importKey: false,
            key: ""
          });
        })

        .catch(popupAjaxError);
    },

    activateEncrypt() {
      this.set("inProgress", true);

      const publicStr = this.get("model.custom_fields.encrypt_public_key");
      const privateStr = this.get("model.custom_fields.encrypt_private_key");
      const salt = this.get("model.custom_fields.encrypt_salt");
      const passphrase = this.get("passphrase");

      // 1. a. Import public key from string.
      // 1. b. Import private from string (using passphrase).
      const importPub = importPublicKey(publicStr);
      const importPrv = generatePassphraseKey(passphrase, salt).then(
        passphraseKey => importPrivateKey(privateStr, passphraseKey)
      );

      Ember.RSVP.Promise.all([importPub, importPrv])

        // 2. Save key pair in local IndexedDb.
        .then(([publicKey, privateKey]) =>
          saveKeyPairToIndexedDb(publicKey, privateKey)
        )

        // 3. Reset component status.
        .then(() => {
          this.appEvents.trigger("encrypt:status-changed");

          this.send("hidePassphraseInput");
          this.setProperties({
            inProgress: false,
            isEncryptEnabled: true,
            isEncryptActive: true
          });
        })

        .catch(() => {
          this.set("inProgress", false);
          bootbox.alert(I18n.t("encrypt.preferences.passphrase_invalid"));
        });
    },

    changeEncrypt() {
      this.set("inProgress", true);

      const oldPublicStr = this.get("model.custom_fields.encrypt_public_key");
      const oldPrivateStr = this.get("model.custom_fields.encrypt_private_key");
      const oldSalt = this.get("model.custom_fields.encrypt_salt");
      const oldPassphrase = this.get("oldPassphrase");
      const salt = generateSalt();
      const passphrase = this.get("passphrase");

      // 1. a. Decrypt private key with old passphrase.
      // 1. b. Generate new passphrase key.
      const p0 = generatePassphraseKey(oldPassphrase, oldSalt).then(
        // Import key as extractable so it can be later exported.
        passphraseKey => importPrivateKey(oldPrivateStr, passphraseKey, true)
      );
      const p1 = generatePassphraseKey(passphrase, salt);

      Ember.RSVP.Promise.all([p0, p1])

        // 2. Encrypt private key with new passphrase key.
        .then(([privateKey, passphraseKey]) =>
          exportPrivateKey(privateKey, passphraseKey)
        )

        // 3. Send old public key (unchanged) and new private key back to
        // server.
        .then(privateStr => {
          this.set("model.custom_fields.encrypt_private_key", privateStr);
          this.set("model.custom_fields.encrypt_salt", salt);
          return ajax("/encrypt/keys", {
            type: "PUT",
            data: { public_key: oldPublicStr, private_key: privateStr, salt }
          });
        })

        // 4. Reset component status.
        .then(() => {
          this.send("hidePassphraseInput");
          this.set("inProgress", false);
        })

        .catch(() => {
          this.set("inProgress", false);
          bootbox.alert(I18n.t("encrypt.preferences.passphrase_invalid"));
        });
    },

    deactivateEncrypt() {
      this.setProperties("inProgress", true);

      deleteIndexedDb().then(() => {
        this.appEvents.trigger("encrypt:status-changed");
        this.setProperties({
          inProgress: false,
          isEncryptEnabled: true,
          isEncryptActive: false
        });
      });
    },

    export() {
      showModal("export-keypair");
    }
  }
};
