import Object3D from "~/lib/core/Object3D";
import MathUtils from "~/lib/math/MathUtils";
import Camera from "~/lib/core/Camera";
import Vec2 from "~/lib/math/Vec2";
import TileExtrudedMesh from "./TileExtrudedMesh";
import TileProjectedMesh from "./TileProjectedMesh";
import TileLabelBuffers from "./TileLabelBuffers";
import Tile3DBuffers, {
	Tile3DBuffersExtruded,
	Tile3DBuffersLabels
} from "~/lib/tile-processing/tile3d/buffers/Tile3DBuffers";
import TileHuggingMesh from "~/app/objects/TileHuggingMesh";

// position.xyz, scale, rotation
export type InstanceBufferInterleaved = Float32Array;
export type InstanceType = 'tree';

export type TileInstanceBuffers = Map<InstanceType, {
	rawLOD0: InstanceBufferInterleaved;
	rawLOD1: InstanceBufferInterleaved;
	transformedLOD0: InstanceBufferInterleaved;
	transformedLOD1: InstanceBufferInterleaved;
	transformOriginLOD0: Vec2;
	transformOriginLOD1: Vec2;
}>;

export default class Tile extends Object3D {
	private static counter = 0;

	public readonly x: number;
	public readonly y: number;
	public readonly localId: number;

	public readonly buildingLocalToPackedMap: Map<number, number> = new Map();
	public readonly buildingPackedToLocalMap: Map<number, number> = new Map();
	public readonly buildingOffsetMap: Map<number, [number, number]> = new Map();
	public readonly buildingVisibilityMap: Map<number, boolean> = new Map();

	public inFrustum: boolean = true;
	public distanceToCamera: number = null;
	public disposed = false;
	public labelBuffersList: TileLabelBuffers[] = [];
	public buildingsNeedFiltering: boolean = true;
	public instanceBuffers: TileInstanceBuffers = new Map();

	public extrudedMesh: TileExtrudedMesh;
	public projectedMesh: TileProjectedMesh;
	public huggingMesh: TileHuggingMesh;

	public usedHeightTiles: Vec2[] = [];

	public constructor(x: number, y: number) {
		super();

		this.x = x;
		this.y = y;

		this.localId = Tile.counter++;

		if (Tile.counter > 65535) {
			Tile.counter = 0;
		}

		this.updatePosition();
	}

	private updatePosition(): void {
		const positionInMeters = MathUtils.tile2meters(this.x, this.y + 1);

		this.position.set(positionInMeters.x, 0, positionInMeters.y);
		this.updateMatrix();
	}

	public async load(buffersPromise: Promise<Tile3DBuffers>): Promise<void> {
		return buffersPromise.then((buffers: Tile3DBuffers) => {
			this.updateExtrudedGeometryOffsets(buffers.extruded);

			this.extrudedMesh = new TileExtrudedMesh(buffers.extruded);
			this.projectedMesh = new TileProjectedMesh(buffers.projected);
			this.huggingMesh = new TileHuggingMesh(buffers.hugging);

			this.add(this.extrudedMesh, this.projectedMesh, this.huggingMesh);
			this.updateLabelBufferList(buffers.labels);

			/*for (const [key, LOD0Value] of Object.entries(this.staticGeometry.instancesLOD0)) {
				const LOD1Value = this.staticGeometry.instancesLOD1[key as InstanceType];

				this.instanceBuffers.set(key as InstanceType, {
					rawLOD0: LOD0Value,
					rawLOD1: LOD1Value,
					transformedLOD0: new Float32Array(LOD0Value),
					transformedLOD1: new Float32Array(LOD1Value),
					transformOriginLOD0: new Vec2(NaN, NaN),
					transformOriginLOD1: new Vec2(NaN, NaN)
				});
			}*/
		});
	}

	public getInstanceBufferWithTransform(instanceName: InstanceType, lod: number, origin: Vec2): InstanceBufferInterleaved {
		const buffers = this.instanceBuffers.get(instanceName);

		if (!buffers) {
			return null;
		}

		const lodKey = lod === 0 ? 'LOD0' : 'LOD1';
		const transformed = buffers[`transformed${lodKey}`];
		const transformOrigin = buffers[`transformOrigin${lodKey}`];

		if (transformOrigin.equals(origin)) {
			return transformed;
		}

		const raw = buffers[`raw${lodKey}`];

		for (let i = 0; i < raw.length; i += 5) {
			transformed[i] = raw[i] - origin.x + this.position.x;
			transformed[i + 2] = raw[i + 2] - origin.y + this.position.z;
		}

		transformOrigin.x = origin.x;
		transformOrigin.y = origin.y;

		return transformed;
	}

	private updateLabelBufferList(buffers: Tile3DBuffersLabels): void {
		for (let i = 0; i < buffers.text.length; i++) {
			const text = buffers.text[i];
			const priority = buffers.priority[i];
			const mercatorScale = MathUtils.getMercatorScaleFactorForTile(this.x, this.y, 16);
			const x = this.position.x + buffers.position[i * 3];
			const y = this.position.y + buffers.position[i * 3 + 1] * mercatorScale;
			const z = this.position.z + buffers.position[i * 3 + 2];

			const label = new TileLabelBuffers({
				text,
				priority,
				x,
				y,
				z
			});
			this.labelBuffersList.push(label);
		}
	}

	public updateDistanceToCamera(camera: Camera): void {
		const worldPosition = MathUtils.tile2meters(this.x + 0.5, this.y + 0.5);
		this.distanceToCamera = Math.sqrt((worldPosition.x - camera.position.x) ** 2 + (worldPosition.y - camera.position.z) ** 2);
	}

	private updateExtrudedGeometryOffsets(extrudedBuffers: Tile3DBuffersExtruded): void {
		const ids = extrudedBuffers.idBuffer;
		const offsets = extrudedBuffers.offsetBuffer;
		const vertexCount = extrudedBuffers.positionBuffer.length / 3;

		for (let i = 0; i < ids.length; i += 2) {
			const id = MathUtils.shiftLeft(ids[i + 1] & 0x7FFFF, 32) + ids[i];
			const type = ids[i + 1] >> 19;

			const packedId = Tile.packFeatureId(id, type);

			const offset = offsets[i / 2];
			const nextOffset = offsets[i / 2 + 1] || vertexCount;
			this.buildingLocalToPackedMap.set(i / 2, packedId);
			this.buildingPackedToLocalMap.set(packedId, i / 2);
			this.buildingOffsetMap.set(packedId, [offset, nextOffset - offset]);
			this.buildingVisibilityMap.set(packedId, true);
		}
	}

	public hideBuilding(id: number): void {
		const [start, size] = this.buildingOffsetMap.get(id);

		this.extrudedMesh.addDisplayBufferPatch({start, size, value: 255});
		this.buildingVisibilityMap.set(id, false);
	}

	public showBuilding(id: number): void  {
		const [start, size] = this.buildingOffsetMap.get(id);

		this.extrudedMesh.addDisplayBufferPatch({start, size, value: 0});
		this.buildingVisibilityMap.set(id, true);
	}

	public isBuildingVisible(id: number): boolean {
		return this.buildingVisibilityMap.get(id);
	}

	public dispose(): void  {
		this.disposed = true;

		if (this.extrudedMesh) {
			this.extrudedMesh.dispose();
			this.extrudedMesh = null;
		}

		if (this.projectedMesh) {
			this.projectedMesh.dispose();
			this.projectedMesh = null;
		}

		if (this.huggingMesh) {
			this.huggingMesh.dispose();
			this.huggingMesh = null;
		}

		if (this.parent) {
			this.parent.remove(this);
		}
	}

	public static encodePosition(x: number, y: number): number {
		return x << 16 + y;
	}

	public static decodePosition(encoded: number): Vec2 {
		return new Vec2(encoded >> 16, encoded & 0xffff);
	}

	public static packFeatureId(id: number, type: number): number {
		return MathUtils.shiftLeft(type, 51) + id;
	}

	public static unpackFeatureId(packedId: number): [number, number] {
		const type = MathUtils.shiftRight(packedId, 51);
		let id = packedId;

		if (id >= 2 ** 52) {
			id -= 2 ** 52;
		}
		if (id >= 2 ** 51) {
			id -= 2 ** 51;
		}

		return [type, id];
	}
}
