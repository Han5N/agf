/**
 * Primary button: consumes the confirm and cancel intents.
 *
 * The same control behaves identically under keyboard, touch and gamepad
 * because it only knows intents. Adding a long-press on touch changes the
 * binding table, not this file.
 */
import type { SceneContext } from "../scenes/main.js";

export interface ButtonOptions {
  label: string;
  onPress?: () => void;
}

export function createPrimaryButton(ctx: SceneContext, options: ButtonOptions) {
  const detachers: Array<() => void> = [];
  let mounted = false;

  return {
    mount(): void {
      if (mounted) return;
      mounted = true;
      detachers.push(
        ctx.intents.on("confirm", () => {
          options.onPress?.();
        }),
      );
      detachers.push(
        ctx.intents.on("cancel", () => {
          // The button does not own cancellation; the scene decides. It only
          // guarantees the event is not swallowed here.
        }),
      );
    },
    unmount(): void {
      while (detachers.length > 0) detachers.pop()?.();
      mounted = false;
    },
    get label(): string {
      return options.label;
    },
  };
}
