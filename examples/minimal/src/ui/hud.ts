/**
 * Heads-up display: renders the move intent as a direction indicator.
 *
 * It consumes an intent, not a keyboard event. Switching to a gamepad or a
 * virtual stick does not change this file.
 */
import type { SceneContext } from "../scenes/main.js";

export function createHud(ctx: SceneContext) {
  let detach: (() => void) | null = null;
  let axis = { x: 0, y: 0 };

  return {
    mount(): void {
      detach = ctx.intents.on("move", (payload) => {
        const next = payload as { x?: number; y?: number };
        axis = { x: next.x ?? 0, y: next.y ?? 0 };
      });
    },
    unmount(): void {
      detach?.();
      detach = null;
    },
    get axis(): { x: number; y: number } {
      return axis;
    },
  };
}
