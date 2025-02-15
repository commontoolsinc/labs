import { register } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon, TrayIconEvent } from "@tauri-apps/api/tray";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";
import { defaultWindowIcon } from '@tauri-apps/api/app';


export const setupNotifications = async () => {
  // Do you have permission to send a notification?
  let permissionGranted = await isPermissionGranted();

  // If not we need to request it
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === "granted";
  }

  return {
    permissionGranted,
    send: async function notify(
      options: NotificationOptions = {
        title: "Tauri",
        body: "This is a default notification!",
      },
    ) {
      // we could consider settings from the user that dictates where
      // and if to send a notification
      // e.g. check `settings.notificationsEnabled`

      // we could also use a framework library or custom code to
      // render this notification in the DOM, and use a signal such
      // as the `await window.isFocused()` to determine where to send
      // e.g.
      // import { getCurrent } from "@tauri-apps/api/window";
      // const window = getCurrent();
      // const focused = await window.isFocused()

      if (permissionGranted) {
        return sendNotification(options);
      }
    },
  };
};

export type NotificationAPI = ReturnType<typeof setupNotifications>;

export const setupGlobalShortcuts = async () => {
  const window = getCurrentWindow();

  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) window.hide();
  });

  await register("Ctrl+Alt+Command+Space", async (event) => {
    console.log("Shortcut triggered");
    if (event?.state !== "Pressed") {
        return;
    }
    const window = getCurrentWindow();

    if (await window.isFocused()) {
      await window.hide();
    } else {
      // uses the default window size and centers
      await window.center();
      await window.show();
      await window.setFocus();
    }
  });
};

export const setupTray = async ({ tooltip }: { tooltip?: string }) => {
  const action = async (event: TrayIconEvent) => {
    const { clickType } = event;
    const window = getCurrentWindow();

    // The mini-pop-up window should automatically
    //  hide once you stop giving it focus
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) window.hide();
    });

    if (clickType === "Right") {
      await window.hide();
    } else {
      console.log(event);
      await window.show();
      const size = new LogicalSize(800, 600);
      await window.setSize(size);
      const iconOffset = 30;
      const position = new LogicalPosition(
        event.position.x - size.width,
        event.position.y - size.height - iconOffset,
      );
    //   await window.setPosition(position);
      await window.setFocus();
    }
  };
  tray = await TrayIcon.new({ id: "js_tray_icon", action });
  if (tooltip) tray.setTooltip(tooltip);
  await tray.setIcon(await defaultWindowIcon());
  const menu = await Menu.new();
  await tray.setMenu(menu);
  return menu;
};
