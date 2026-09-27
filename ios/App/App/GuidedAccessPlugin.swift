import Foundation
import UIKit
import Capacitor

/**
 * GuidedAccessPlugin
 *
 * Capacitor iOS Plugin for Apple Guided Access (Single App Mode) Supervision
 * and real-time app-switching detection.
 *
 * Events emitted:
 *   - guidedAccessStatusChanged: { enabled: Bool, timestamp: Double }
 *   - appSwitchDetected: { event: String, timestamp: Double, guidedAccessActive: Bool }
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
        setupNotificationObservers()
    }

    /**
     * Set up NotificationCenter observers for:
     * - Guided Access status changes
     * - App becoming active (return from background / app switcher)
     * - App resigning active (FIRST signal of app switch — fired as soon as swipe up begins)
     * - App entering background (HOME button pressed / full switch away)
     */
    private func setupNotificationObservers() {
        guard !isObserving else { return }

        // Guided Access status changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleGuidedAccessStatusChange),
            name: UIAccessibility.guidedAccessStatusDidChangeNotification,
            object: nil
        )

        // App returns to foreground — re-check Guided Access status
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppBecameActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        // App ABOUT TO resign active — earliest detection point for app switching
        // Fires when: Home button pressed, swipe-up gesture begins, incoming call overlay appears
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )

        // App entered full background state
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppEnteredBackground),
            name: UIApplication.didEnterBackgroundNotification,
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
        setupNotificationObservers()

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
     * Stops listening for all Guided Access and app-switch notifications.
     */
    @objc func stopGuidedAccessListener(_ call: CAPPluginCall) {
        if isObserving {
            NotificationCenter.default.removeObserver(self)
            isObserving = false
        }
        call.resolve(["listening": false])
    }

    /**
     * Handler: Guided Access status changed (system accessibility notification)
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

    /**
     * Handler: App became active again (returned from switcher / background)
     * Re-checks Guided Access status in case student disabled it while away.
     */
    @objc private func handleAppBecameActive() {
        DispatchQueue.main.async {
            let isEnabled = UIAccessibility.isGuidedAccessEnabled
            // Emit fresh GA status so JS can gate on it
            self.notifyListeners("guidedAccessStatusChanged", data: [
                "enabled": isEnabled,
                "timestamp": Date().timeIntervalSince1970 * 1000
            ])
        }
    }

    /**
     * Handler: App ABOUT TO resign active.
     * This is the FIRST event fired when a student swipes up for the home screen
     * or app switcher. Emit a violation event so JS can react immediately.
     */
    @objc private func handleAppWillResignActive() {
        DispatchQueue.main.async {
            let gaEnabled = UIAccessibility.isGuidedAccessEnabled
            self.notifyListeners("appSwitchDetected", data: [
                "event": "WILL_RESIGN_ACTIVE",
                "timestamp": Date().timeIntervalSince1970 * 1000,
                "guidedAccessActive": gaEnabled
            ])
        }
    }

    /**
     * Handler: App has entered the background.
     * Fires after sceneWillResignActive when student fully switches away.
     */
    @objc private func handleAppEnteredBackground() {
        DispatchQueue.main.async {
            let gaEnabled = UIAccessibility.isGuidedAccessEnabled
            self.notifyListeners("appSwitchDetected", data: [
                "event": "DID_ENTER_BACKGROUND",
                "timestamp": Date().timeIntervalSince1970 * 1000,
                "guidedAccessActive": gaEnabled
            ])
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
