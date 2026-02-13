import Phaser from "phaser";

type TileRow = string[];

export type IsoSnapshot = {
  tiles: TileRow[];
  entities: Array<{
    id: string;
    type: "resource" | "creature";
    subtype: string;
    x: number;
    y: number;
    quantity: number;
  }>;
  actor: {
    x: number;
    y: number;
  };
  placements: Array<{ id: string; prefabId: string; x: number; y: number }>;
};

const TILE_W = 24;
const TILE_H = 12;

const TERRAIN_TEXTURE: Record<string, string> = {
  plains: "terrain-plains",
  forest: "terrain-forest",
  mountain: "terrain-mountain",
  water: "terrain-water"
};

const RESOURCE_TEXTURE: Record<string, string> = {
  wood: "resource-wood",
  stone: "resource-stone",
  fiber: "resource-fiber",
  mushroom: "resource-mushroom"
};

const CREATURE_TEXTURE: Record<string, string> = {
  wolf: "creature-wolf",
  slime: "creature-slime"
};

const PREFAB_TEXTURE: Record<string, string> = {
  campfire: "prefab-campfire",
  crate: "prefab-crate",
  totem: "prefab-totem",
  workbench: "prefab-workbench",
  house: "prefab-house",
  fence: "prefab-fence"
};

const TEXTURE_PATHS: Record<string, string> = {
  "terrain-plains": "/assets/isometric/terrain-plains.png",
  "terrain-forest": "/assets/isometric/terrain-forest.png",
  "terrain-mountain": "/assets/isometric/terrain-mountain.png",
  "terrain-water": "/assets/isometric/terrain-water.png",
  "resource-wood": "/assets/isometric/resource-wood.png",
  "resource-stone": "/assets/isometric/resource-stone.png",
  "resource-fiber": "/assets/isometric/resource-fiber.png",
  "resource-mushroom": "/assets/isometric/resource-mushroom.png",
  "creature-wolf": "/assets/isometric/creature-wolf.png",
  "creature-slime": "/assets/isometric/creature-slime.png",
  "prefab-campfire": "/assets/isometric/prefab-campfire.png",
  "prefab-crate": "/assets/isometric/prefab-crate.png",
  "prefab-totem": "/assets/isometric/prefab-totem.png",
  "prefab-workbench": "/assets/isometric/prefab-workbench.png",
  "prefab-house": "/assets/isometric/prefab-house.png",
  "prefab-fence": "/assets/isometric/prefab-fence.png",
  "actor-player": "/assets/isometric/actor-player.png"
};

const TERRAIN_SPRITE_SIZE = 68;
const TERRAIN_SPRITE_OFFSET_Y = 8;
const RESOURCE_SPRITE_SIZE = 30;
const CREATURE_SPRITE_SIZE = 34;
const ACTOR_SPRITE_SIZE = 36;
const DEFAULT_ZOOM = 1.35;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.12;
const CAMERA_PAN_SPEED = 460;
const HOVER_OFFSET_X = 12;
const HOVER_OFFSET_Y = 12;
const HOVER_MARGIN = 6;

type CameraKeys = {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
};

const PREFAB_SPRITE_SIZE: Record<string, number> = {
  house: 86,
  fence: 44,
  campfire: 34,
  totem: 42,
  workbench: 46,
  crate: 36
};

function toIso(x: number, y: number) {
  return {
    ix: (x - y) * TILE_W,
    iy: (x + y) * TILE_H
  };
}

function terrainColor(terrain: string): number {
  switch (terrain) {
    case "forest":
      return 0x2f6a3f;
    case "mountain":
      return 0x6d6d73;
    case "water":
      return 0x2d5f9b;
    default:
      return 0x7e8a52;
  }
}

function resourceColor(subtype: string): number {
  switch (subtype) {
    case "wood":
      return 0x8d5b3c;
    case "stone":
      return 0x9ca3af;
    case "fiber":
      return 0x8dbf58;
    case "mushroom":
      return 0xcc6677;
    default:
      return 0xcaa66f;
  }
}

export class IsometricScene extends Phaser.Scene {
  private snapshot: IsoSnapshot | null = null;
  private cameraKeys: CameraKeys | null = null;
  private cameraFollowActor = true;
  private hoverElement: HTMLDivElement | null = null;

  public constructor() {
    super("world");
  }

  public preload(): void {
    for (const [key, path] of Object.entries(TEXTURE_PATHS)) {
      if (!this.textures.exists(key)) {
        this.load.image(key, path);
      }
    }
  }

  public create(): void {
    this.cameras.main.setBackgroundColor("#10161f");
    this.cameras.main.setZoom(DEFAULT_ZOOM);
    this.ensureDomTooltip();

    const keys = this.input.keyboard?.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      down: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT
    });
    this.cameraKeys = (keys as CameraKeys | undefined) ?? null;
    this.input.keyboard?.addCapture([
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT
    ]);

    this.input.on("wheel", this.onWheelZoom, this);
    this.input.on("pointerdown", this.onMapPointerDown, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off("wheel", this.onWheelZoom, this);
      this.input.off("pointerdown", this.onMapPointerDown, this);
      this.hoverElement?.remove();
      this.hoverElement = null;
    });
  }

  public setSnapshot(snapshot: IsoSnapshot): void {
    this.snapshot = snapshot;
    this.renderSnapshot();
  }

  public override update(_time: number, delta: number): void {
    if (!this.cameraKeys || this.isTextInputFocused()) {
      return;
    }

    let panX = 0;
    let panY = 0;

    if (this.cameraKeys.left.isDown) {
      panX -= 1;
    }
    if (this.cameraKeys.right.isDown) {
      panX += 1;
    }
    if (this.cameraKeys.up.isDown) {
      panY -= 1;
    }
    if (this.cameraKeys.down.isDown) {
      panY += 1;
    }

    if (panX === 0 && panY === 0) {
      return;
    }

    if (panX !== 0 && panY !== 0) {
      panX *= Math.SQRT1_2;
      panY *= Math.SQRT1_2;
    }

    const camera = this.cameras.main;
    const step = (CAMERA_PAN_SPEED * (delta / 1000)) / camera.zoom;
    camera.scrollX += panX * step;
    camera.scrollY += panY * step;
    this.cameraFollowActor = false;
  }

  private hasTexture(key: string): boolean {
    return this.textures.exists(key);
  }

  private onMapPointerDown(): void {
    this.blurFocusedTextInput();
  }

  private blurFocusedTextInput(): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return;
    }
    const tag = active.tagName;
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
    if (isTextInput) {
      active.blur();
    }
  }

  private isTextInputFocused(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return false;
    }
    const tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
  }

  private onWheelZoom(
    pointer: Phaser.Input.Pointer,
    _currentlyOver: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number
  ): void {
    const camera = this.cameras.main;
    const zoomDirection = Math.sign(deltaY);
    if (zoomDirection === 0) {
      return;
    }

    const nextZoom = Phaser.Math.Clamp(camera.zoom - zoomDirection * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === camera.zoom) {
      return;
    }

    const worldBefore = camera.getWorldPoint(pointer.x, pointer.y);
    camera.setZoom(nextZoom);
    const worldAfter = camera.getWorldPoint(pointer.x, pointer.y);
    camera.scrollX += worldBefore.x - worldAfter.x;
    camera.scrollY += worldBefore.y - worldAfter.y;
    this.cameraFollowActor = false;
    this.positionHover(pointer);
  }

  private ensureDomTooltip(): HTMLDivElement | null {
    if (this.hoverElement) {
      return this.hoverElement;
    }
    const parent = this.game.canvas.parentElement;
    if (!parent) {
      return null;
    }

    const computed = window.getComputedStyle(parent);
    if (computed.position === "static") {
      parent.style.position = "relative";
    }

    const tooltip = document.createElement("div");
    tooltip.style.position = "absolute";
    tooltip.style.left = "0";
    tooltip.style.top = "0";
    tooltip.style.transform = "translate(-9999px, -9999px)";
    tooltip.style.pointerEvents = "none";
    tooltip.style.zIndex = "20";
    tooltip.style.padding = "6px 8px";
    tooltip.style.borderRadius = "6px";
    tooltip.style.border = "1px solid rgba(255, 255, 255, 0.2)";
    tooltip.style.background = "rgba(7, 16, 27, 0.92)";
    tooltip.style.color = "#f3eadf";
    tooltip.style.font = "11px \"SF Pro Text\", \"Avenir Next\", \"Segoe UI\", sans-serif";
    tooltip.style.lineHeight = "1.3";
    tooltip.style.whiteSpace = "pre";
    tooltip.style.display = "none";

    parent.appendChild(tooltip);
    this.hoverElement = tooltip;
    return tooltip;
  }

  private showHover(pointer: Phaser.Input.Pointer, lines: string[]): void {
    const tooltip = this.ensureDomTooltip();
    if (!tooltip) {
      return;
    }
    tooltip.textContent = lines.join("\n");
    tooltip.style.display = "block";
    this.positionHover(pointer);
  }

  private positionHover(pointer: Phaser.Input.Pointer): void {
    const tooltip = this.hoverElement;
    if (!tooltip || tooltip.style.display === "none") {
      return;
    }
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    let x = pointer.x + HOVER_OFFSET_X;
    let y = pointer.y + HOVER_OFFSET_Y;
    const maxX = this.scale.width - width - HOVER_MARGIN;
    const maxY = this.scale.height - height - HOVER_MARGIN;
    x = Phaser.Math.Clamp(x, HOVER_MARGIN, Math.max(HOVER_MARGIN, maxX));
    y = Phaser.Math.Clamp(y, HOVER_MARGIN, Math.max(HOVER_MARGIN, maxY));
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  }

  private hideHover(): void {
    if (!this.hoverElement) {
      return;
    }
    this.hoverElement.style.display = "none";
    this.hoverElement.style.transform = "translate(-9999px, -9999px)";
  }

  private attachHover(target: Phaser.GameObjects.GameObject, lines: string[]): void {
    target.setInteractive({ useHandCursor: false });
    target.on("pointerover", (pointer: Phaser.Input.Pointer) => {
      this.showHover(pointer, lines);
    });
    target.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.positionHover(pointer);
    });
    target.on("pointerout", () => {
      this.hideHover();
    });
  }

  private drawTerrainFallback(gx: number, gy: number, terrain: string, depth: number): Phaser.GameObjects.Polygon {
    const poly = this.add.polygon(
      gx,
      gy,
      [
        0,
        -TILE_H,
        TILE_W,
        0,
        0,
        TILE_H,
        -TILE_W,
        0
      ],
      terrainColor(terrain),
      1
    );
    poly.setDepth(depth);
    poly.setStrokeStyle(1, 0x0a0a0a, 0.25);
    return poly;
  }

  private drawPlacementFallback(
    gx: number,
    gy: number,
    prefabId: string,
    depth: number
  ): Phaser.GameObjects.GameObject {
    if (prefabId === "house") {
      const base = this.add.rectangle(gx, gy - 2, 18, 10, 0x8f6e46, 0.98);
      base.setDepth(depth);
      const roof = this.add.triangle(gx, gy - 10, 0, 0, 10, 7, -10, 7, 0xc35a3f, 0.98);
      roof.setDepth(depth + 0.1);
      return roof;
    }

    if (prefabId === "fence") {
      const plank = this.add.rectangle(gx, gy, 14, 4, 0xc8a26e, 0.98);
      plank.setDepth(depth);
      return plank;
    }

    if (prefabId === "campfire") {
      const pit = this.add.circle(gx, gy, 4.5, 0x6b4e3b, 1);
      pit.setDepth(depth);
      const flame = this.add.circle(gx, gy - 2, 2.5, 0xffa13a, 0.95);
      flame.setDepth(depth + 0.1);
      return flame;
    }

    if (prefabId === "totem") {
      const totem = this.add.rectangle(gx, gy - 4, 5, 14, 0x9e7a55, 0.98);
      totem.setDepth(depth);
      return totem;
    }

    if (prefabId === "workbench") {
      const bench = this.add.rectangle(gx, gy, 12, 6, 0xa67b52, 0.98);
      bench.setDepth(depth);
      return bench;
    }

    if (prefabId === "crate") {
      const crate = this.add.rectangle(gx, gy, 8, 8, 0xbd8b4d, 0.98);
      crate.setDepth(depth);
      return crate;
    }

    const rect = this.add.rectangle(gx, gy, 8, 8, 0xd5a65f, 0.95);
    rect.setDepth(depth);
    return rect;
  }

  private renderSnapshot(): void {
    if (!this.snapshot) {
      return;
    }

    this.hideHover();
    this.children.removeAll();

    const centerX = this.scale.width * 0.5;
    const centerY = 70;

    for (let y = 0; y < this.snapshot.tiles.length; y += 1) {
      const row = this.snapshot.tiles[y];
      if (!row) {
        continue;
      }

      for (let x = 0; x < row.length; x += 1) {
        const terrain = row[x] ?? "plains";
        const textureKey = TERRAIN_TEXTURE[terrain] ?? "terrain-plains";
        const { ix, iy } = toIso(x, y);
        const gx = centerX + ix;
        const gy = centerY + iy;
        const depth = y * 10 + x;

        if (this.hasTexture(textureKey)) {
          const tile = this.add.image(gx, gy + TERRAIN_SPRITE_OFFSET_Y, textureKey);
          tile.setDisplaySize(TERRAIN_SPRITE_SIZE, TERRAIN_SPRITE_SIZE);
          tile.setDepth(depth);
          this.attachHover(tile, [`Terrain: ${terrain}`, `Tile: (${x}, ${y})`]);
        } else {
          const poly = this.drawTerrainFallback(gx, gy, terrain, depth);
          this.attachHover(poly, [`Terrain: ${terrain}`, `Tile: (${x}, ${y})`]);
        }
      }
    }

    for (const entity of this.snapshot.entities) {
      const { ix, iy } = toIso(entity.x, entity.y);
      const gx = centerX + ix;
      const gy = centerY + iy - 8;
      const depth = 700 + entity.y * 10 + entity.x;

      if (entity.type === "resource") {
        const textureKey = RESOURCE_TEXTURE[entity.subtype] ?? "resource-wood";
        if (this.hasTexture(textureKey)) {
          const sprite = this.add.image(gx, gy, textureKey);
          sprite.setDisplaySize(RESOURCE_SPRITE_SIZE, RESOURCE_SPRITE_SIZE);
          sprite.setOrigin(0.5, 0.74);
          sprite.setDepth(depth);
          this.attachHover(sprite, [`Resource: ${entity.subtype}`, `Qty: ${entity.quantity}`, `Tile: (${entity.x}, ${entity.y})`]);
        } else {
          const node = this.add.circle(gx, gy, 3.5, resourceColor(entity.subtype), 0.95);
          node.setDepth(depth);
          this.attachHover(node, [`Resource: ${entity.subtype}`, `Qty: ${entity.quantity}`, `Tile: (${entity.x}, ${entity.y})`]);
        }
      } else {
        const textureKey = CREATURE_TEXTURE[entity.subtype] ?? "creature-slime";
        if (this.hasTexture(textureKey)) {
          const sprite = this.add.image(gx, gy, textureKey);
          sprite.setDisplaySize(CREATURE_SPRITE_SIZE, CREATURE_SPRITE_SIZE);
          sprite.setOrigin(0.5, 0.78);
          sprite.setDepth(depth);
          this.attachHover(sprite, [`Creature: ${entity.subtype}`, `Tile: (${entity.x}, ${entity.y})`]);
        } else {
          const marker = this.add.triangle(gx, gy, 0, 6, 5, -4, -5, -4, 0xa85454, 0.95);
          marker.setDepth(depth);
          this.attachHover(marker, [`Creature: ${entity.subtype}`, `Tile: (${entity.x}, ${entity.y})`]);
        }
      }
    }

    for (const placement of this.snapshot.placements) {
      const { ix, iy } = toIso(placement.x, placement.y);
      const gx = centerX + ix;
      const gy = centerY + iy - 8;
      const depth = 1000 + placement.y * 10 + placement.x;
      const textureKey = PREFAB_TEXTURE[placement.prefabId];

      if (textureKey && this.hasTexture(textureKey)) {
        const size = PREFAB_SPRITE_SIZE[placement.prefabId] ?? 40;
        const sprite = this.add.image(gx, gy, textureKey);
        sprite.setDisplaySize(size, size);
        sprite.setOrigin(0.5, 0.82);
        sprite.setDepth(depth);
        this.attachHover(sprite, [`Structure: ${placement.prefabId}`, `Tile: (${placement.x}, ${placement.y})`]);
      } else {
        const fallback = this.drawPlacementFallback(gx, gy, placement.prefabId, depth);
        this.attachHover(fallback, [`Structure: ${placement.prefabId}`, `Tile: (${placement.x}, ${placement.y})`]);
      }
    }

    const actor = this.snapshot.actor;
    const actorIso = toIso(actor.x, actor.y);
    const actorX = centerX + actorIso.ix;
    const actorY = centerY + actorIso.iy - 8;
    const actorDepth = 2000 + actor.y * 10 + actor.x;

    if (this.cameraFollowActor) {
      this.cameras.main.centerOn(actorX, actorY);
    }

    if (this.hasTexture("actor-player")) {
      const actorSprite = this.add.image(actorX, actorY, "actor-player");
      actorSprite.setDisplaySize(ACTOR_SPRITE_SIZE, ACTOR_SPRITE_SIZE);
      actorSprite.setOrigin(0.5, 0.8);
      actorSprite.setDepth(actorDepth);
      this.attachHover(actorSprite, [`Actor`, `Tile: (${actor.x}, ${actor.y})`]);
    } else {
      const actorCircle = this.add.circle(actorX, actorY, 5, 0xffd166, 1);
      actorCircle.setDepth(actorDepth);
      this.attachHover(actorCircle, [`Actor`, `Tile: (${actor.x}, ${actor.y})`]);
    }
  }
}
