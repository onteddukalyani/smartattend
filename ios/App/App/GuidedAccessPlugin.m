#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

/**
 * Objective-C Macro Bridge for GuidedAccessPlugin
 * Enables Capacitor iOS runtime bridge discovery.
 */
CAP_PLUGIN(GuidedAccessPlugin, "GuidedAccessPlugin",
    CAP_PLUGIN_METHOD(isGuidedAccessEnabled, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startGuidedAccessListener, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopGuidedAccessListener, CAPPluginReturnPromise);
)
