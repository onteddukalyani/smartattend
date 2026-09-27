import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /**
     * Called when the app is about to resign active (e.g. incoming call overlay, app switcher swipe up).
     * This is the EARLIEST signal of an app switch on iOS — fires before sceneDidEnterBackground.
     * Posting a UIApplication.willResignActiveNotification-equivalent for GuidedAccessPlugin to pick up.
     */
    func sceneWillResignActive(_ scene: UIScene) {
        NotificationCenter.default.post(
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
    }

    /**
     * Called when the scene has fully entered the background (home button pressed / app switched).
     * Capacitor's ApplicationDelegateProxy automatically bridges UIApplicationDelegate callbacks,
     * but SceneDelegate lifecycle methods need to be forwarded explicitly for app-switch detection.
     */
    func sceneDidEnterBackground(_ scene: UIScene) {
        NotificationCenter.default.post(
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    /**
     * Called when the scene becomes active again after returning from background or app switcher.
     * Fires didBecomeActiveNotification so GuidedAccessPlugin can re-query Guided Access status.
     */
    func sceneDidBecomeActive(_ scene: UIScene) {
        NotificationCenter.default.post(
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }
}
