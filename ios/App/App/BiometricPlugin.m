#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

/**
 * Objective-C Macro Bridge for BiometricPlugin
 * Enables Capacitor iOS runtime bridge discovery.
 */
CAP_PLUGIN(BiometricPlugin, "BiometricPlugin",
    CAP_PLUGIN_METHOD(isHardwareAvailable, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(createBiometricKey, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(signChallenge, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getBiometricKeyStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(deleteBiometricKey, CAPPluginReturnPromise);
)
