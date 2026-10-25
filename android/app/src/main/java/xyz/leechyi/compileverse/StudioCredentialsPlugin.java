package xyz.leechyi.compileverse;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "StudioCredentials")
public class StudioCredentialsPlugin extends Plugin {
    private static final String ALIAS = "compileverse.studio.session";
    private SharedPreferences storage() { return getContext().getSharedPreferences("studio_credentials", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private String slot(PluginCall call, String field) {
        String scope = call.getString("key");
        return scope == null ? field : field + ":" + scope;
    }
    @PluginMethod public void set(PluginCall call) {
        String token = call.getString("token");
        if (token == null) { call.reject("Missing token"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            if (!storage().edit().putString(slot(call, "iv"), Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString(slot(call, "data"), Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) throw new Exception("Storage failed");
            call.resolve();
        } catch (Exception e) { call.reject("Unable to protect session", e); }
    }
    @PluginMethod public void get(PluginCall call) {
        try {
            String data = storage().getString(slot(call, "data"), null), iv = storage().getString(slot(call, "iv"), null);
            JSObject result = new JSObject();
            if (data != null && iv != null) {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
                result.put("token", new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception e) { storage().edit().remove(slot(call, "data")).remove(slot(call, "iv")).apply(); call.resolve(new JSObject()); }
    }
    @PluginMethod public void clear(PluginCall call) { storage().edit().remove(slot(call, "data")).remove(slot(call, "iv")).apply(); call.resolve(); }
}
