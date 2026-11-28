package com.takencafe.ravi.fresh;

import android.os.CancellationSignal;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException;

@CapacitorPlugin(name = "RaviGoogleCredentials")
public class RaviGoogleCredentials extends Plugin {
    private static final String SERVER_CLIENT_ID =
        "499485108378-ppjn8civdcfciltc34na3q33sh1ld4u3.apps.googleusercontent.com";

    @PluginMethod
    public void requestIdToken(PluginCall call) {
        String nonce = call.getString("nonce");
        if (nonce == null || !nonce.matches("[A-Za-z0-9_-]{32,128}")) {
            call.reject("A valid sign-in challenge is required.");
            return;
        }
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(SERVER_CLIENT_ID)
            .setNonce(nonce)
            .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build();
        getActivity().runOnUiThread(() ->
            CredentialManager.create(getActivity()).getCredentialAsync(
                getActivity(), request, new CancellationSignal(), ContextCompat.getMainExecutor(getActivity()),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse response) {
                        Credential credential = response.getCredential();
                        if (!(credential instanceof CustomCredential)
                            || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                            call.reject("Google did not return a sign-in credential.");
                            return;
                        }
                        try {
                            GoogleIdTokenCredential token = GoogleIdTokenCredential.createFrom(credential.getData());
                            JSObject result = new JSObject();
                            result.put("idToken", token.getIdToken());
                            call.resolve(result);
                        } catch (GoogleIdTokenParsingException error) {
                            call.reject("Could not read the Google sign-in credential.");
                        }
                    }

                    @Override
                    public void onError(GetCredentialException error) {
                        if (error instanceof GetCredentialCancellationException) {
                            call.reject("Google sign-in cancelled.", "CANCELLED");
                        } else {
                            call.reject("Google sign-in is unavailable on this device.", "GOOGLE_SIGN_IN_FAILED");
                        }
                    }
                }
            )
        );
    }
}
