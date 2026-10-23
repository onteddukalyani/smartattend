import test from "node:test";
import assert from "node:assert/strict";
import {
  dismissAppUpdate,
  hasAppUpdateNotificationBeenShown,
  isAppUpdateDismissed,
  markAppUpdateNotificationShown
} from "../src/utils/appUpdateDismissal.js";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test("dismissing an optional update persists until a different version is published", () => {
  const storage = createStorage();

  assert.equal(isAppUpdateDismissed("1.0.3", storage), false);
  assert.equal(dismissAppUpdate("1.0.3", storage), true);
  assert.equal(isAppUpdateDismissed("1.0.3", storage), true);
  assert.equal(isAppUpdateDismissed("1.0.4", storage), false);
});

test("update notifications are recorded once per released version", () => {
  const storage = createStorage();

  assert.equal(hasAppUpdateNotificationBeenShown("1.0.3", storage), false);
  assert.equal(markAppUpdateNotificationShown("1.0.3", storage), true);
  assert.equal(hasAppUpdateNotificationBeenShown("1.0.3", storage), true);
  assert.equal(hasAppUpdateNotificationBeenShown("1.0.4", storage), false);
});

test("dismissal and notification helpers safely handle unavailable storage", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("Storage unavailable");
    },
    setItem() {
      throw new Error("Storage unavailable");
    },
    removeItem() {
      throw new Error("Storage unavailable");
    }
  };

  assert.equal(isAppUpdateDismissed("1.0.3", unavailableStorage), false);
  assert.equal(dismissAppUpdate("1.0.3", unavailableStorage), false);
  assert.equal(hasAppUpdateNotificationBeenShown("1.0.3", unavailableStorage), false);
  assert.equal(markAppUpdateNotificationShown("1.0.3", unavailableStorage), false);
});
