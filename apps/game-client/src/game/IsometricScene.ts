import Phaser from "phaser";

type TileRow = string[];

type HoverTarget = Phaser.GameObjects.GameObject & {
  setInteractive: (config?: Phaser.Types.Input.InputConfiguration) => Phaser.GameObjects.GameObject;
  on: Phaser.Events.EventEmitter["on"];
  setPosition: (x?: number, y?: number, z?: number, w?: number) => Phaser.GameObjects.GameObject;
  setDepth: (value: number) => Phaser.GameObjects.GameObject;
};

type TerrainCellRender = {
  terrain: string;
  object: Phaser.GameObjects.GameObject;
  edge: Phaser.GameObjects.Polygon | null;
};

type EntityRender = {
  id: string;
  type: "resource" | "creature";
  subtype: string;
  x: number;
  y: number;
  quantity: number;
  object: Phaser.GameObjects.GameObject;
};

type PlacementRender = {
  id: string;
  prefabId: string;
  x: number;
  y: number;
  object: Phaser.GameObjects.GameObject;
};

type ActorRender = {
  x: number;
  y: number;
  object: Phaser.GameObjects.GameObject;
};

export type IsoSnapshot = {
  seed: number;
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

const TERRAIN_TEXTURES: Record<string, string[]> = {
  plains: ["terrain-plains-01", "terrain-plains-02", "terrain-plains-03", "terrain-plains-04"],
  forest: ["terrain-forest-01", "terrain-forest-02", "terrain-forest-03", "terrain-forest-04"],
  mountain: ["terrain-mountain-01", "terrain-mountain-02", "terrain-mountain-03", "terrain-mountain-04"],
  water: ["terrain-water-01", "terrain-water-02", "terrain-water-03", "terrain-water-04"]
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
  "terrain-plains-01": "/assets/isometric/terrain-plains-01.png",
  "terrain-plains-02": "/assets/isometric/terrain-plains-02.png",
  "terrain-plains-03": "/assets/isometric/terrain-plains-03.png",
  "terrain-plains-04": "/assets/isometric/terrain-plains-04.png",
  "terrain-forest": "/assets/isometric/terrain-forest.png",
  "terrain-forest-01": "/assets/isometric/terrain-forest-01.png",
  "terrain-forest-02": "/assets/isometric/terrain-forest-02.png",
  "terrain-forest-03": "/assets/isometric/terrain-forest-03.png",
  "terrain-forest-04": "/assets/isometric/terrain-forest-04.png",
  "terrain-mountain": "/assets/isometric/terrain-mountain.png",
  "terrain-mountain-01": "/assets/isometric/terrain-mountain-01.png",
  "terrain-mountain-02": "/assets/isometric/terrain-mountain-02.png",
  "terrain-mountain-03": "/assets/isometric/terrain-mountain-03.png",
  "terrain-mountain-04": "/assets/isometric/terrain-mountain-04.png",
  "terrain-water": "/assets/isometric/terrain-water.png",
  "terrain-water-01": "/assets/isometric/terrain-water-01.png",
  "terrain-water-02": "/assets/isometric/terrain-water-02.png",
  "terrain-water-03": "/assets/isometric/terrain-water-03.png",
  "terrain-water-04": "/assets/isometric/terrain-water-04.png",
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

const TERRAIN_BASE_DEPTH = 0;
const ENTITY_BASE_DEPTH = 700;
const PLACEMENT_BASE_DEPTH = 1000;
const ACTOR_BASE_DEPTH = 2000;

const PREFAB_SPRITE_SIZE: Record<string, number> = {
  house: 86,
  fence: 44,
  campfire: 34,
  totem: 42,
  workbench: 46,
  crate: 36
};

type CameraKeys = {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
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
  private hoverLines = new WeakMap<Phaser.GameObjects.GameObject, () => string[]>();

  private terrainGrid: TerrainCellRender[][] = [];
  private entityRenders = new Map<string, EntityRender>();
  private placementRenders = new Map<string, PlacementRender>();
  private actorRender: ActorRender | null = null;
  private layoutDirty = true;

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

    this.ensureTooltipElement();

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
    this.input.on("gameout", this.hideHover, this);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off("wheel", this.onWheelZoom, this);
      this.input.off("pointerdown", this.onMapPointerDown, this);
      this.input.off("gameout", this.hideHover, this);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
      this.hoverElement?.remove();
      this.hoverElement = null;
      this.destroyAllRenderObjects();
    });
  }

  public setSnapshot(snapshot: IsoSnapshot): void {
    this.snapshot = snapshot;
    this.syncRenderState();
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

  private onResize(): void {
    this.layoutDirty = true;
    this.syncRenderState();
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
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) {
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

  private ensureTooltipElement(): HTMLDivElement | null {
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

  private pointerWithinSurface(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    const parent = this.game.canvas.parentElement;
    if (!parent) {
      return { x: pointer.x, y: pointer.y };
    }

    const event = pointer.event as MouseEvent | PointerEvent | WheelEvent | undefined;
    if (event && typeof event.clientX === "number" && typeof event.clientY === "number") {
      const rect = parent.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    }

    return { x: pointer.x, y: pointer.y };
  }

  private showHover(pointer: Phaser.Input.Pointer, lines: string[]): void {
    const tooltip = this.ensureTooltipElement();
    if (!tooltip) {
      return;
    }

    tooltip.textContent = lines.join("\n");
    tooltip.style.display = "block";
    this.positionHover(pointer);
  }

  private positionHover(pointer: Phaser.Input.Pointer): void {
    const tooltip = this.hoverElement;
    const parent = this.game.canvas.parentElement;
    if (!tooltip || !parent || tooltip.style.display === "none") {
      return;
    }

    const pointerPos = this.pointerWithinSurface(pointer);
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;

    let x = pointerPos.x + HOVER_OFFSET_X;
    let y = pointerPos.y + HOVER_OFFSET_Y;

    const maxX = parent.clientWidth - width - HOVER_MARGIN;
    const maxY = parent.clientHeight - height - HOVER_MARGIN;
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

  private attachHover(target: Phaser.GameObjects.GameObject, linesProvider: () => string[]): void {
    const interactive = target as HoverTarget;
    interactive.setInteractive({ useHandCursor: false });
    this.hoverLines.set(target, linesProvider);

    interactive.on("pointerover", (pointer: Phaser.Input.Pointer) => {
      const provider = this.hoverLines.get(target);
      if (!provider) {
        return;
      }
      this.showHover(pointer, provider());
    });
    interactive.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      const provider = this.hoverLines.get(target);
      if (!provider) {
        return;
      }
      this.showHover(pointer, provider());
    });
    interactive.on("pointerout", () => {
      this.hideHover();
    });
  }

  private terrainVariantSeed(x: number, y: number, salt: number): number {
    const seed = this.snapshot?.seed ?? 0;
    let value = seed ^ Math.imul(x + 13, 374761393) ^ Math.imul(y + 29, 668265263) ^ salt;
    value ^= value >>> 13;
    value = Math.imul(value, 1274126177);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967295;
  }

  private pickTerrainTexture(terrain: string, x: number, y: number): string {
    const variants = TERRAIN_TEXTURES[terrain] ?? ["terrain-plains"];
    const index = Math.floor(this.terrainVariantSeed(x, y, 17) * variants.length) % variants.length;
    const variantKey = variants[index] ?? variants[0] ?? "terrain-plains";
    if (this.hasTexture(variantKey)) {
      return variantKey;
    }

    const baseKey = `terrain-${terrain}`;
    if (this.hasTexture(baseKey)) {
      return baseKey;
    }
    return "terrain-plains";
  }

  private mapOrigin(): { centerX: number; centerY: number } {
    return {
      centerX: this.scale.width * 0.5,
      centerY: 70
    };
  }

  private tileToScreen(x: number, y: number, offsetY = 0): { gx: number; gy: number } {
    const { ix, iy } = toIso(x, y);
    const { centerX, centerY } = this.mapOrigin();
    return {
      gx: centerX + ix,
      gy: centerY + iy + offsetY
    };
  }

  private destroyTerrainGrid(): void {
    for (const row of this.terrainGrid) {
      for (const cell of row) {
        cell.edge?.destroy();
        cell.object.destroy();
      }
    }
    this.terrainGrid = [];
  }

  private destroyAllRenderObjects(): void {
    this.destroyTerrainGrid();

    for (const render of this.entityRenders.values()) {
      render.object.destroy();
    }
    this.entityRenders.clear();

    for (const render of this.placementRenders.values()) {
      render.object.destroy();
    }
    this.placementRenders.clear();

    this.actorRender?.object.destroy();
    this.actorRender = null;
  }

  private terrainDepth(x: number, y: number): number {
    return TERRAIN_BASE_DEPTH + y * 10 + x;
  }

  private entityDepth(x: number, y: number): number {
    return ENTITY_BASE_DEPTH + y * 10 + x;
  }

  private placementDepth(x: number, y: number): number {
    return PLACEMENT_BASE_DEPTH + y * 10 + x;
  }

  private actorDepth(x: number, y: number): number {
    return ACTOR_BASE_DEPTH + y * 10 + x;
  }

  private createTerrainObject(terrain: string, x: number, y: number): Phaser.GameObjects.GameObject {
    const textureKey = this.pickTerrainTexture(terrain, x, y);
    let object: Phaser.GameObjects.GameObject;

    if (this.hasTexture(textureKey)) {
      const tile = this.add.image(0, 0, textureKey);
      tile.setDisplaySize(TERRAIN_SPRITE_SIZE, TERRAIN_SPRITE_SIZE);
      object = tile;
    } else {
      object = this.add.polygon(
        0,
        0,
        [0, -TILE_H, TILE_W, 0, 0, TILE_H, -TILE_W, 0],
        terrainColor(terrain),
        1
      );
      (object as Phaser.GameObjects.Polygon).setStrokeStyle(1, 0x0a0a0a, 0.25);
    }

    const positioned = object as HoverTarget;
    const point = this.tileToScreen(x, y, TERRAIN_SPRITE_OFFSET_Y);
    positioned.setPosition(point.gx, point.gy);
    positioned.setDepth(this.terrainDepth(x, y));

    this.attachHover(object, () => [`Terrain: ${terrain}`, `Tile: (${x}, ${y})`]);
    return object;
  }

  private positionTerrainObject(object: Phaser.GameObjects.GameObject, x: number, y: number): void {
    const positioned = object as HoverTarget;
    const point = this.tileToScreen(x, y, TERRAIN_SPRITE_OFFSET_Y);
    positioned.setPosition(point.gx, point.gy);
    positioned.setDepth(this.terrainDepth(x, y));
  }

  private positionTerrainEdge(edge: Phaser.GameObjects.Polygon, x: number, y: number): void {
    const point = this.tileToScreen(x, y);
    edge.setPosition(point.gx, point.gy);
    edge.setDepth(this.terrainDepth(x, y) + 0.05);
  }

  private edgeStyleForTile(
    tiles: TileRow[],
    x: number,
    y: number,
    terrain: string
  ): { color: number; alpha: number } | null {
    const neighbors = [
      tiles[y]?.[x - 1],
      tiles[y]?.[x + 1],
      tiles[y - 1]?.[x],
      tiles[y + 1]?.[x]
    ].filter((value): value is string => typeof value === "string");

    if (neighbors.length === 0) {
      return null;
    }

    const hasWaterNeighbor = neighbors.some((neighbor) => neighbor === "water");
    if (terrain !== "water" && hasWaterNeighbor) {
      return { color: 0x5da7db, alpha: 0.42 };
    }

    const hasDifferent = neighbors.some((neighbor) => neighbor !== terrain);
    if (!hasDifferent) {
      return null;
    }

    if (terrain === "mountain") {
      return { color: 0xc3c8d1, alpha: 0.32 };
    }
    if (terrain === "forest") {
      return { color: 0x9edb9d, alpha: 0.24 };
    }
    if (terrain === "plains") {
      return { color: 0xdcc17a, alpha: 0.2 };
    }
    return null;
  }

  private syncTerrainEdges(tiles: TileRow[]): void {
    for (let y = 0; y < tiles.length; y += 1) {
      const sourceRow = tiles[y] ?? [];
      const row = this.terrainGrid[y];
      if (!row) {
        continue;
      }

      for (let x = 0; x < sourceRow.length; x += 1) {
        const cell = row[x];
        if (!cell) {
          continue;
        }
        const style = this.edgeStyleForTile(tiles, x, y, cell.terrain);
        if (!style) {
          cell.edge?.destroy();
          cell.edge = null;
          continue;
        }

        if (!cell.edge) {
          cell.edge = this.add.polygon(
            0,
            0,
            [0, -TILE_H, TILE_W, 0, 0, TILE_H, -TILE_W, 0],
            0x000000,
            0
          );
        }
        cell.edge.setStrokeStyle(1, style.color, style.alpha);
        this.positionTerrainEdge(cell.edge, x, y);
      }
    }
  }

  private syncTerrain(tiles: TileRow[]): void {
    const height = tiles.length;

    while (this.terrainGrid.length > height) {
      const row = this.terrainGrid.pop();
      if (!row) {
        continue;
      }
      for (const cell of row) {
        cell.edge?.destroy();
        cell.object.destroy();
      }
    }

    for (let y = 0; y < height; y += 1) {
      const sourceRow = tiles[y] ?? [];
      const row = this.terrainGrid[y] ?? [];
      this.terrainGrid[y] = row;

      while (row.length > sourceRow.length) {
        const cell = row.pop();
        cell?.edge?.destroy();
        cell?.object.destroy();
      }

      for (let x = 0; x < sourceRow.length; x += 1) {
        const terrain = sourceRow[x] ?? "plains";
        const current = row[x];

        if (!current || current.terrain !== terrain) {
          current?.edge?.destroy();
          current?.object.destroy();
          row[x] = {
            terrain,
            object: this.createTerrainObject(terrain, x, y),
            edge: null
          };
          continue;
        }

        if (this.layoutDirty) {
          this.positionTerrainObject(current.object, x, y);
          if (current.edge) {
            this.positionTerrainEdge(current.edge, x, y);
          }
        }
      }
    }

    this.syncTerrainEdges(tiles);
  }

  private createEntityRender(entity: IsoSnapshot["entities"][number]): EntityRender {
    const render: EntityRender = {
      id: entity.id,
      type: entity.type,
      subtype: entity.subtype,
      x: entity.x,
      y: entity.y,
      quantity: entity.quantity,
      object: this.add.circle(0, 0, 1, 0xffffff, 1)
    };
    render.object.destroy();

    if (entity.type === "resource") {
      const textureKey = RESOURCE_TEXTURE[entity.subtype] ?? "resource-wood";
      if (this.hasTexture(textureKey)) {
        const sprite = this.add.image(0, 0, textureKey);
        sprite.setDisplaySize(RESOURCE_SPRITE_SIZE, RESOURCE_SPRITE_SIZE);
        sprite.setOrigin(0.5, 0.74);
        render.object = sprite;
      } else {
        render.object = this.add.circle(0, 0, 3.5, resourceColor(entity.subtype), 0.95);
      }
    } else {
      const textureKey = CREATURE_TEXTURE[entity.subtype] ?? "creature-slime";
      if (this.hasTexture(textureKey)) {
        const sprite = this.add.image(0, 0, textureKey);
        sprite.setDisplaySize(CREATURE_SPRITE_SIZE, CREATURE_SPRITE_SIZE);
        sprite.setOrigin(0.5, 0.78);
        render.object = sprite;
      } else {
        render.object = this.add.triangle(0, 0, 0, 6, 5, -4, -5, -4, 0xa85454, 0.95);
      }
    }

    this.attachHover(render.object, () => {
      if (render.type === "resource") {
        return [`Resource: ${render.subtype}`, `Qty: ${render.quantity}`, `Tile: (${render.x}, ${render.y})`];
      }
      return [`Creature: ${render.subtype}`, `Tile: (${render.x}, ${render.y})`];
    });

    return render;
  }

  private positionEntityRender(render: EntityRender): void {
    const positioned = render.object as HoverTarget;
    const point = this.tileToScreen(render.x, render.y, -8);
    positioned.setPosition(point.gx, point.gy);
    positioned.setDepth(this.entityDepth(render.x, render.y));
  }

  private syncEntities(entities: IsoSnapshot["entities"]): void {
    const seen = new Set<string>();

    for (const entity of entities) {
      seen.add(entity.id);
      let render = this.entityRenders.get(entity.id);

      if (!render || render.type !== entity.type || render.subtype !== entity.subtype) {
        render?.object.destroy();
        render = this.createEntityRender(entity);
        this.entityRenders.set(entity.id, render);
      }

      render.x = entity.x;
      render.y = entity.y;
      render.quantity = entity.quantity;
      this.positionEntityRender(render);
    }

    for (const [id, render] of this.entityRenders) {
      if (seen.has(id)) {
        continue;
      }
      render.object.destroy();
      this.entityRenders.delete(id);
    }
  }

  private createPlacementObject(prefabId: string): Phaser.GameObjects.GameObject {
    const textureKey = PREFAB_TEXTURE[prefabId];
    if (textureKey && this.hasTexture(textureKey)) {
      const size = PREFAB_SPRITE_SIZE[prefabId] ?? 40;
      const sprite = this.add.image(0, 0, textureKey);
      sprite.setDisplaySize(size, size);
      sprite.setOrigin(0.5, 0.82);
      return sprite;
    }

    if (prefabId === "house") {
      return this.add.triangle(0, 0, 0, 0, 10, 7, -10, 7, 0xc35a3f, 0.98);
    }
    if (prefabId === "fence") {
      return this.add.rectangle(0, 0, 14, 4, 0xc8a26e, 0.98);
    }
    if (prefabId === "campfire") {
      return this.add.circle(0, 0, 2.5, 0xffa13a, 0.95);
    }
    if (prefabId === "totem") {
      return this.add.rectangle(0, 0, 5, 14, 0x9e7a55, 0.98);
    }
    if (prefabId === "workbench") {
      return this.add.rectangle(0, 0, 12, 6, 0xa67b52, 0.98);
    }
    if (prefabId === "crate") {
      return this.add.rectangle(0, 0, 8, 8, 0xbd8b4d, 0.98);
    }

    return this.add.rectangle(0, 0, 8, 8, 0xd5a65f, 0.95);
  }

  private createPlacementRender(placement: IsoSnapshot["placements"][number]): PlacementRender {
    const render: PlacementRender = {
      id: placement.id,
      prefabId: placement.prefabId,
      x: placement.x,
      y: placement.y,
      object: this.createPlacementObject(placement.prefabId)
    };

    this.attachHover(render.object, () => [`Structure: ${render.prefabId}`, `Tile: (${render.x}, ${render.y})`]);
    return render;
  }

  private positionPlacementRender(render: PlacementRender): void {
    const positioned = render.object as HoverTarget;
    const point = this.tileToScreen(render.x, render.y, -8);
    positioned.setPosition(point.gx, point.gy);
    positioned.setDepth(this.placementDepth(render.x, render.y));
  }

  private syncPlacements(placements: IsoSnapshot["placements"]): void {
    const seen = new Set<string>();

    for (const placement of placements) {
      seen.add(placement.id);
      let render = this.placementRenders.get(placement.id);

      if (!render || render.prefabId !== placement.prefabId) {
        render?.object.destroy();
        render = this.createPlacementRender(placement);
        this.placementRenders.set(placement.id, render);
      }

      render.x = placement.x;
      render.y = placement.y;
      this.positionPlacementRender(render);
    }

    for (const [id, render] of this.placementRenders) {
      if (seen.has(id)) {
        continue;
      }
      render.object.destroy();
      this.placementRenders.delete(id);
    }
  }

  private createActorObject(): Phaser.GameObjects.GameObject {
    if (this.hasTexture("actor-player")) {
      const sprite = this.add.image(0, 0, "actor-player");
      sprite.setDisplaySize(ACTOR_SPRITE_SIZE, ACTOR_SPRITE_SIZE);
      sprite.setOrigin(0.5, 0.8);
      return sprite;
    }
    return this.add.circle(0, 0, 5, 0xffd166, 1);
  }

  private syncActor(actor: IsoSnapshot["actor"]): void {
    if (!this.actorRender) {
      const actorRender: ActorRender = {
        x: actor.x,
        y: actor.y,
        object: this.createActorObject()
      };
      this.attachHover(actorRender.object, () => [`Actor`, `Tile: (${actorRender.x}, ${actorRender.y})`]);
      this.actorRender = actorRender;
    }

    if (!this.actorRender) {
      return;
    }

    this.actorRender.x = actor.x;
    this.actorRender.y = actor.y;

    const positioned = this.actorRender.object as HoverTarget;
    const point = this.tileToScreen(actor.x, actor.y, -8);
    positioned.setPosition(point.gx, point.gy);
    positioned.setDepth(this.actorDepth(actor.x, actor.y));

    if (this.cameraFollowActor) {
      this.cameras.main.centerOn(point.gx, point.gy);
    }
  }

  private syncRenderState(): void {
    if (!this.snapshot) {
      return;
    }

    this.syncTerrain(this.snapshot.tiles);
    this.syncEntities(this.snapshot.entities);
    this.syncPlacements(this.snapshot.placements);
    this.syncActor(this.snapshot.actor);
    this.layoutDirty = false;
  }
}
