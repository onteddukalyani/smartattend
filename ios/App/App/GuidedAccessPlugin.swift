import Foundation
import UIKit
import Capacitor

/**
 * GuidedAccessPlugin
 * 
 * Capacitor iOS Plugin for Apple Guided Access (Single App Mode) Supervision.
 * Detects whether Guided Access is active and listens for real-time status transitions.
 */
@objc(GuidedAccessPlugin)
public class GuidedAccessPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuidedAccessPlugin"
    public let jsName = "GuidedAccessPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isGuidedAccessEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startGuidedAccessListener", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopGuidedAccessListener", returnType: CAPPluginReturnPromise)
    ]
    
    private var isObserving = false

    override public func load() {
        super.load()
        setupNotificationObserver()
    }

    /**
     * Set up NotificationCenter observer for UIAccessibility.guidedAccessStatusDidChangeNotification
     */
    private func setupNotificationObserver() {
        guard !isObserving else { return }
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleGuidedAccessStatusChange),
            name: UIAccessibility.guidedAccessStatusDidChangeNotification,
            object: nil
        )
        
        // Also observe when app returns to foreground to ensure fresh status check
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleGuidedAccessStatusChange),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        
        isObserving = true
    }

    /**
     * Checks if Guided Access is currently active on the device.
     * Returns: { enabled: Bool, isSupported: Bool }
     */
    @objc func isGuidedAccessEnabled(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let isEnabled = UIAccessibility.isGuidedAccessEnabled
            call.resolve([
                "enabled": isEnabled,
                "isSupported": true,
                "platform": "ios"
            ])
        }
    }

    /**
     * Starts listening for Guided Access status changes and immediately emits current status.
     */
    @objc func startGuidedAccessListener(_ call: CAPPluginCall) {
        setupNotificationObserver()
        
        DispatchQueue.main.async {
            let isEnabled = UIAccessibility.isGuidedAccessEnabled
            self.notifyListeners("guidedAccessStatusChanged", data: [
                "enabled": isEnabled,
                "timestamp": Date().timeIntervalSince1970 * 1000
            ])
            
            call.resolve([
                "listening": true,
                "currentStatus": isEnabled
            ])
        }
    }

    /**
     * Stops listening for Guided Access status notifications.
     */
    @objc func stopGuidedAccessListener(_ call: CAPPluginCall) {
        if isObserving {
            NotificationCenter.default.removeObserver(
                self,
                name: UIAccessibility.guidedAccessStatusDidChangeNotification,
                object: nil
            )
            NotificationCenter.default.removeObserver(
                self,
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            isObserving = false
        }
        call.resolve(["listening": false])
    }

    /**
     * Handler invoked whenever iOS fires guidedAccessStatusDidChangeNotification
     */
    @objc private func handleGuidedAccessStatusChange() {
        DispatchQueue.main.async {
            let isEnabled = UIAccessibility.isGuidedAccessEnabled
            self.notifyListeners("guidedAccessStatusChanged", data: [
                "enabled": isEnabled,
                "timestamp": Date().timeIntervalSince1970 * 1000
            ])
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
