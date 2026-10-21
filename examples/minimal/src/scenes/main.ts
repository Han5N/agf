/**
 * Main scene: assembly only.
 *
 * Past roughly 80 lines of assembly, something in here is not assembly.
 * The scene must not know what a button looks like, or which key was pressed.
 */
import { createHud } from "../ui/hud.js";
import { createPrimaryButton } from "../ui/button.js";

/** Capabilities injected by the runtime. Scenes never touch canvas or window. */
export interface SceneContext {
  assets: {
    image(id: string): CanvasImageSource;
  };
  intents: {
    on(id: string, handler: (payload: unknown) => void): () => void;
  };
  layer: {
    add(node: unknown): void;
    remove(node: unknown): void;
  };
}

export function createMainScene(ctx: SceneContext) {
  const hud = createHud(ctx);
  const button = createPrimaryButton(ctx, { label: "Start" });

  return {
    mount(): void {
      ctx.layer.add(ctx.assets.image("bg_menu"));
      hud.mount();
      button.mount();
    },
    unmount(): void {
      button.unmount();
      hud.unmount();
    },
  };
}
