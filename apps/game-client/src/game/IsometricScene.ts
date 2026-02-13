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

  private actorCircle: Phaser.GameObjects.Arc | null = null;

  public constructor() {
    super("world");
  }

  public create(): void {
    this.cameras.main.setBackgroundColor("#10161f");
  }

  public setSnapshot(snapshot: IsoSnapshot): void {
    this.snapshot = snapshot;
    this.renderSnapshot();
  }

  private renderSnapshot(): void {
    if (!this.snapshot) {
      return;
    }

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
        const { ix, iy } = toIso(x, y);
        const gx = centerX + ix;
        const gy = centerY + iy;
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
        poly.setStrokeStyle(1, 0x0a0a0a, 0.25);
      }
    }

    for (const entity of this.snapshot.entities) {
      const { ix, iy } = toIso(entity.x, entity.y);
      const gx = centerX + ix;
      const gy = centerY + iy - 8;
      const depth = 700 + entity.y * 10 + entity.x;
      if (entity.type === "resource") {
        const node = this.add.circle(gx, gy, 3.5, resourceColor(entity.subtype), 0.95);
        node.setDepth(depth);
      } else {
        const marker = this.add.triangle(gx, gy, 0, 6, 5, -4, -5, -4, 0xa85454, 0.95);
        marker.setDepth(depth);
      }
    }

    for (const placement of this.snapshot.placements) {
      const { ix, iy } = toIso(placement.x, placement.y);
      const gx = centerX + ix;
      const gy = centerY + iy - 8;
      const depth = 1000 + placement.y * 10 + placement.x;

      if (placement.prefabId === "house") {
        const base = this.add.rectangle(gx, gy - 2, 18, 10, 0x8f6e46, 0.98);
        base.setDepth(depth);
        const roof = this.add.triangle(gx, gy - 10, 0, 0, 10, 7, -10, 7, 0xc35a3f, 0.98);
        roof.setDepth(depth + 0.1);
      } else if (placement.prefabId === "fence") {
        const plank = this.add.rectangle(gx, gy, 14, 4, 0xc8a26e, 0.98);
        plank.setDepth(depth);
      } else if (placement.prefabId === "campfire") {
        const pit = this.add.circle(gx, gy, 4.5, 0x6b4e3b, 1);
        pit.setDepth(depth);
        const flame = this.add.circle(gx, gy - 2, 2.5, 0xffa13a, 0.95);
        flame.setDepth(depth + 0.1);
      } else if (placement.prefabId === "totem") {
        const totem = this.add.rectangle(gx, gy - 4, 5, 14, 0x9e7a55, 0.98);
        totem.setDepth(depth);
      } else if (placement.prefabId === "workbench") {
        const bench = this.add.rectangle(gx, gy, 12, 6, 0xa67b52, 0.98);
        bench.setDepth(depth);
      } else if (placement.prefabId === "crate") {
        const crate = this.add.rectangle(gx, gy, 8, 8, 0xbd8b4d, 0.98);
        crate.setDepth(depth);
      } else {
        const rect = this.add.rectangle(gx, gy, 8, 8, 0xd5a65f, 0.95);
        rect.setDepth(depth);
      }
    }

    const actor = this.snapshot.actor;
    const actorIso = toIso(actor.x, actor.y);
    this.actorCircle = this.add.circle(centerX + actorIso.ix, centerY + actorIso.iy - 8, 5, 0xffd166, 1);
    this.actorCircle.setDepth(2000 + actor.y * 10 + actor.x);
  }
}
