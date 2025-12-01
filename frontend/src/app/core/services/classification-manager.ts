import * as THREE from 'three';

export interface PointIdentifier {
  sourceId?: string;
  tileKey: string;
  pointIndex: number;
  unstable?: boolean;
}

export interface ClassificationChangeSummary {
  totalPoints: number;
  deltas: Record<number, number>;
}

interface ClassificationHistoryEntry {
  points: Array<{
    object: any;
    index: number;
    identifier: PointIdentifier;
    previousColor: { r: number; g: number; b: number };
    newColor: { r: number; g: number; b: number };
    previousClassification: number | null;
    newClassification: number;
  }>;
  classificationId: number;
  timestamp: Date;
}

export type SelectedPoint = {
  position: THREE.Vector3;
  index: number;
  object: any;
  identifier: PointIdentifier;
};

interface OverrideEntry {
  classValue: number;
  color: THREE.Color;
}

interface ClusterOverrideBackupEntry {
  classification: number;
  color?: THREE.Color;
}

export interface ClassificationManagerContext {
  getCamera(): THREE.Camera | null;
  getScene(): THREE.Scene | null;
  getPointCloudEntity(): any | null;
  notifyChange(): void;
}

export class ClassificationManager {
  private readonly MAX_HISTORY = 50;

  private classificationHistory: ClassificationHistoryEntry[] = [];
  private historyIndex = -1;

  private selectionPreviewSphere: THREE.Mesh | null = null;

  private classifiedPointsLayer: THREE.Points | null = null;
  private classifiedPointsData = new Map<string, { position: THREE.Vector3; color: THREE.Color }>();
  private classificationPreviewLayer: THREE.Points | null = null;

  private classifiedPointIndices: Set<string> = new Set();
  private fallbackWarningEmitted = false;
  private pendingOverrides = new Map<string, Map<number, OverrideEntry>>();
  private overridePaletteFallback = new THREE.Color(1, 1, 1);
  private visibleClassificationsFilter: Set<number> | null = null;
  private clusterOverrideBackups: Map<string, Map<number, ClusterOverrideBackupEntry>> | null = null;

  constructor(private readonly context: ClassificationManagerContext) {}

  private resolveSourceId(): string | undefined {
    const entity: any = this.context.getPointCloudEntity();
    return entity?.source?.id ?? entity?.sourceId ?? entity?._sourceId;
  }

  private extractTileKey(object: any): { tileKey: string; unstable: boolean } | null {
    if (!object) {
      return null;
    }

    const name: string | undefined = object.name;
    if (name) {
      return { tileKey: name, unstable: false };
    }

    const userData = object.userData ?? {};
    const userDataKey: string | undefined =
      userData.tileKey ??
      userData.key ??
      userData.id ??
      userData.node?.id ??
      userData.nodeId ??
      userData.nodeKey;

    if (userDataKey) {
      return { tileKey: userDataKey, unstable: false };
    }

    if (object.uuid) {
      return { tileKey: `fallback:${object.uuid}`, unstable: true };
    }

    return null;
  }

  private buildPointIdentifier(object: any, pointIndex: number, sourceId?: string): PointIdentifier | null {
    const resolved = this.extractTileKey(object);

    if (!resolved) {
      if (!this.fallbackWarningEmitted) {
        console.warn('Unable to determine tile key for a point cloud node. Classification persistence may be incomplete.');
        this.fallbackWarningEmitted = true;
      }
      return null;
    }

    const identifier: PointIdentifier = {
      tileKey: resolved.tileKey,
      pointIndex
    };

    if (sourceId) {
      identifier.sourceId = sourceId;
    }

    if (resolved.unstable) {
      identifier.unstable = true;

      if (!this.fallbackWarningEmitted) {
        console.warn('Falling back to runtime UUID for point identification. Consider exposing node IDs for reliable persistence.');
        this.fallbackWarningEmitted = true;
      }
    }

    return identifier;
  }

  private makeIdentifierKey(identifier: PointIdentifier): string {
    const source = identifier.sourceId ?? 'unknown';
    return `${source}|${identifier.tileKey}|${identifier.pointIndex}`;
  }

  /**
   * Set the visible classifications filter for selection operations
   * When set, only points with classifications in this set will be selectable
   */
  setVisibleClassificationsFilter(visibleClassifications: Set<number> | null): void {
    this.visibleClassificationsFilter = visibleClassifications;

    if (visibleClassifications) {
      console.log(`Classification filter active: ${visibleClassifications.size} visible classes`);
    } else {
      console.log('Classification filter disabled');
    }
  }

  /**
   * Check if a point should be included in selection based on classification visibility
   */
  private shouldSelectPoint(
    object: any,
    pointIndex: number,
    visibleClassifications?: Set<number>
  ): boolean {
    // If no filter is set, select all points
    const filter = visibleClassifications ?? this.visibleClassificationsFilter;
    if (!filter) {
      return true;
    }

    try {
      const geometry = object.geometry as THREE.BufferGeometry;
      if (!geometry) {
        return true;
      }

      const classAttr = this.getOrCreateClassificationAttribute(geometry);
      if (!classAttr) {
        return true; // No classification data, include point
      }

      const pointClass = classAttr.getX(pointIndex);
      return filter.has(pointClass);
    } catch (error) {
      console.warn('Error checking point classification visibility:', error);
      return true; // On error, include the point
    }
  }

  selectPointsInBrush(
    screenX: number,
    screenY: number,
    brushSize: number,
    depthPenetration: number
  ): SelectedPoint[] {
    const camera = this.context.getCamera();
    const root = this.getPointCloudRoot();

    if (!camera || !root) {
      console.warn('Cannot select points: camera or point cloud not available');
      return [];
    }

    try {
      const mouse = new THREE.Vector2(
        (screenX / window.innerWidth) * 2 - 1,
        -(screenY / window.innerHeight) * 2 + 1
      );

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, camera as THREE.PerspectiveCamera);
      raycaster.params.Points = { threshold: 5 };

      const intersects = raycaster.intersectObject(root, true);

      if (intersects.length === 0) {
        console.log('No intersection with point cloud');
        return [];
      }

      const hitPoint = intersects[0].point;
      const distance = intersects[0].distance;

      const brushWorldRadius = this.screenToWorldRadius(camera, brushSize, distance);
      const maxDepth = brushWorldRadius * depthPenetration * 2;

      console.log(`🎨 Point selection at (${screenX}, ${screenY})`);
      console.log(`   Hit point: (${hitPoint.x.toFixed(2)}, ${hitPoint.y.toFixed(2)}, ${hitPoint.z.toFixed(2)})`);
      console.log(`   Brush radius: ${brushWorldRadius.toFixed(2)}m`);
      console.log(`   Max depth: ${maxDepth.toFixed(2)}m`);

      return this.queryRealPoints(root, hitPoint, brushWorldRadius, maxDepth);
    } catch (error) {
      console.error('Error selecting points in brush:', error);
      return [];
    }
  }

  async updateSelectionPreview(
    position: THREE.Vector3,
    radius: number,
    color: THREE.Color,
    visible: boolean
  ): Promise<void> {
    const scene = this.context.getScene();
    if (!scene) return;

    await this.initializeSelectionPreview(scene);

    if (!this.selectionPreviewSphere) {
      return;
    }

    this.selectionPreviewSphere.visible = visible;

    if (visible) {
      this.selectionPreviewSphere.position.copy(position);
      this.selectionPreviewSphere.scale.setScalar(radius);

      const material = this.selectionPreviewSphere.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.color.copy(color);
      }

      this.notifyChange();
    }
  }

  hideSelectionPreview(): void {
    if (this.selectionPreviewSphere) {
      this.selectionPreviewSphere.visible = false;
      this.notifyChange();
    }
  }

  async updatePointClassification(
    points: SelectedPoint[],
    classificationValue: number,
    color: THREE.Color,
    sourceClassification?: number | number[] | null
  ): Promise<ClassificationChangeSummary> {
    if (!this.context.getPointCloudEntity() || points.length === 0) {
      return { totalPoints: 0, deltas: {} };
    }

    try {
      console.log(`Updating classification for ${points.length} real points to class ${classificationValue}`);

      const historyEntry: ClassificationHistoryEntry = {
        points: [],
        classificationId: classificationValue,
        timestamp: new Date()
      };

      const deltaCounts = new Map<number, number>();
      const sourceValues = new Set<number>();
      if (Array.isArray(sourceClassification)) {
        sourceClassification.forEach(value => {
          if (value !== undefined && value !== null) {
            sourceValues.add(value);
          }
        });
      } else if (sourceClassification !== undefined && sourceClassification !== null) {
        sourceValues.add(sourceClassification);
      }
      const filterBySource = sourceValues.size > 0;
      let totalChanged = 0;

      const sourceId = this.resolveSourceId();
      const pointsByObject = new Map<any, SelectedPoint[]>();

      points.forEach(point => {
        const identifier = point.identifier ?? this.buildPointIdentifier(point.object, point.index, sourceId);
        if (!identifier) {
          return;
        }

        const enriched: SelectedPoint = {
          position: point.position,
          index: point.index,
          object: point.object,
          identifier
        };

        if (!pointsByObject.has(point.object)) {
          pointsByObject.set(point.object, []);
        }
        pointsByObject.get(point.object)!.push(enriched);
      });

      pointsByObject.forEach((pointGroup, object) => {
        const geometry = object.geometry as THREE.BufferGeometry;
        const positionAttribute = geometry.getAttribute('position');
        if (!positionAttribute) {
          return;
        }

        const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;

        const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
        const applicablePoints = pointGroup.filter(point => {
          if (filterBySource && classificationAttribute) {
            const currentClass = classificationAttribute.getX(point.index);
            return sourceValues.has(currentClass);
          }
          return true;
        });

        if (applicablePoints.length === 0) {
          return;
        }

        applicablePoints.forEach(point => {
          const index = point.index;
          const identifier = point.identifier;

          const prevR = colorAttribute ? colorAttribute.getX(index) : 0;
          const prevG = colorAttribute ? colorAttribute.getY(index) : 0;
          const prevB = colorAttribute ? colorAttribute.getZ(index) : 0;
          const previousClassification = classificationAttribute
            ? classificationAttribute.getX(index)
            : null;

          if (previousClassification !== null && previousClassification !== undefined) {
            deltaCounts.set(
              previousClassification,
              (deltaCounts.get(previousClassification) ?? 0) - 1
            );
          }

          historyEntry.points.push({
            object,
            index,
            identifier,
            previousColor: { r: prevR, g: prevG, b: prevB },
            newColor: { r: prevR, g: prevG, b: prevB },
            previousClassification,
            newClassification: classificationValue
          });

          this.classifiedPointIndices.add(this.makeIdentifierKey(identifier));

          if (classificationAttribute) {
            classificationAttribute.setX(index, classificationValue);
            classificationAttribute.needsUpdate = true;
          }

          totalChanged++;
        });

        console.log(`✓ Updated ${applicablePoints.length} points in geometry`);
      });

      if (totalChanged === 0) {
        console.log('No points matched source classification criteria. No changes applied.');
        return { totalPoints: 0, deltas: {} };
      }

      deltaCounts.set(
        classificationValue,
        (deltaCounts.get(classificationValue) ?? 0) + totalChanged
      );

      this.addToHistory(historyEntry);
      this.notifyChange();
      console.log(`✅ Classification updated for ${totalChanged} points`);

      return {
        totalPoints: totalChanged,
        deltas: Object.fromEntries(deltaCounts)
      };
    } catch (error) {
      console.error('Error updating point classification:', error);
      return { totalPoints: 0, deltas: {} };
    }
  }

  async addClassifiedPoints(points: THREE.Vector3[], color: THREE.Color): Promise<void> {
    const scene = this.context.getScene();
    if (!scene) return;

    await this.initializeClassificationLayer(scene);

    if (!this.classifiedPointsLayer) {
      return;
    }

    try {
      points.forEach(point => {
        const key = `${point.x.toFixed(3)}_${point.y.toFixed(3)}_${point.z.toFixed(3)}`;
        this.classifiedPointsData.set(key, { position: point.clone(), color: color.clone() });
      });

      await this.rebuildClassificationOverlay();
      console.log(`✅ Added ${points.length} classified points (total: ${this.classifiedPointsData.size})`);
    } catch (error) {
      console.error('Failed to add classified points:', error);
    }
  }

  clearClassificationOverlay(): void {
    this.classifiedPointsData.clear();

    if (this.classifiedPointsLayer) {
      const geometry = this.classifiedPointsLayer.geometry as THREE.BufferGeometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
      this.classifiedPointsLayer.visible = false;
    }

    this.notifyChange();
    console.log('✅ Cleared classification overlay');
  }

  private previewAttributeBackup = new Map<string, {
    object: any;
    index: number;
    prevColor?: { r: number; g: number; b: number };
    prevClassification?: number;
  }>();

  async showClassificationPreview(
    points: SelectedPoint[],
    color: THREE.Color,
    classificationValue: number
  ): Promise<void> {
    try {
      this.clearClassificationPreview();

      const appliedKeys = new Set<string>();
      const updatedClassificationAttributes = new Set<THREE.BufferAttribute>();

      points.forEach(point => {
        const geometry = point.object?.geometry as THREE.BufferGeometry | undefined;
        if (!geometry) {
          return;
        }

        const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute | null;
        if (!positionAttribute) {
          return;
        }

        const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
        if (!classificationAttribute) {
          return;
        }

        let colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
        if (!colorAttribute) {
          const colors = new Float32Array(positionAttribute.count * 3);
          for (let i = 0; i < positionAttribute.count; i++) {
            colors[i * 3] = 1;
            colors[i * 3 + 1] = 1;
            colors[i * 3 + 2] = 1;
          }
          colorAttribute = new THREE.BufferAttribute(colors, 3);
          geometry.setAttribute('color', colorAttribute);
        }

        const key = point.identifier
          ? this.makeIdentifierKey(point.identifier)
          : `${point.object?.uuid ?? 'unknown'}|${point.index}`;

        if (!appliedKeys.has(key)) {
          const backup: {
            object: any;
            index: number;
            prevColor?: { r: number; g: number; b: number };
            prevClassification?: number;
          } = {
            object: point.object,
            index: point.index
          };

          backup.prevClassification = classificationAttribute.getX(point.index);

          if (colorAttribute) {
            const prevR = colorAttribute.getX(point.index);
            const prevG = colorAttribute.getY(point.index);
            const prevB = colorAttribute.getZ(point.index);
            backup.prevColor = { r: prevR, g: prevG, b: prevB };
          }

          this.previewAttributeBackup.set(key, backup);
        }

        if (colorAttribute) {
          colorAttribute.setXYZ(point.index, color.r, color.g, color.b);
          colorAttribute.needsUpdate = true;
        }

        if (classificationAttribute.getX(point.index) !== classificationValue) {
          classificationAttribute.setX(point.index, classificationValue);
          updatedClassificationAttributes.add(classificationAttribute);
        }

        appliedKeys.add(key);
      });

      updatedClassificationAttributes.forEach(attribute => {
        attribute.needsUpdate = true;
      });

      if (appliedKeys.size > 0) {
        this.notifyChange();
      }
    } catch (error) {
      console.error('Failed to display classification preview:', error);
    }
  }

  clearClassificationPreview(): void {
    if (this.previewAttributeBackup.size > 0) {
      const classificationAttributesToUpdate = new Set<THREE.BufferAttribute>();
      const colorAttributesToUpdate = new Set<THREE.BufferAttribute>();

      this.previewAttributeBackup.forEach(({ object, index, prevColor, prevClassification }) => {
        const geometry = object?.geometry as THREE.BufferGeometry | undefined;
        if (!geometry) {
          return;
        }

        if (prevClassification !== undefined) {
          const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
          if (classificationAttribute && index < classificationAttribute.count) {
            classificationAttribute.setX(index, prevClassification);
            classificationAttributesToUpdate.add(classificationAttribute);
          }
        }

        if (prevColor) {
          const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
          if (colorAttribute && index < colorAttribute.count) {
            colorAttribute.setXYZ(index, prevColor.r, prevColor.g, prevColor.b);
            colorAttributesToUpdate.add(colorAttribute);
          }
        }
      });

      classificationAttributesToUpdate.forEach(attribute => {
        attribute.needsUpdate = true;
      });

      colorAttributesToUpdate.forEach(attribute => {
        attribute.needsUpdate = true;
      });

      this.previewAttributeBackup.clear();
      this.notifyChange();
    }

    if (this.classificationPreviewLayer) {
      const geometry = this.classificationPreviewLayer.geometry as THREE.BufferGeometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
      this.classificationPreviewLayer.visible = false;
    }
  }

  getClassifiedPointCount(): number {
    return this.classifiedPointsData.size;
  }

  getClassifiedIndexCount(): number {
    return this.classifiedPointIndices.size;
  }

  dispose(): void {
    const scene = this.context.getScene();

    if (scene) {
      if (this.selectionPreviewSphere) {
        scene.remove(this.selectionPreviewSphere);
        this.selectionPreviewSphere.geometry.dispose();
        (this.selectionPreviewSphere.material as THREE.Material).dispose?.();
        this.selectionPreviewSphere = null;
      }

      if (this.classifiedPointsLayer) {
        scene.remove(this.classifiedPointsLayer);
        this.classifiedPointsLayer.geometry.dispose();
        (this.classifiedPointsLayer.material as THREE.Material).dispose?.();
        this.classifiedPointsLayer = null;
      }

      if (this.classificationPreviewLayer) {
        scene.remove(this.classificationPreviewLayer);
        this.classificationPreviewLayer.geometry.dispose();
        (this.classificationPreviewLayer.material as THREE.Material).dispose?.();
        this.classificationPreviewLayer = null;
      }
    }

    this.classifiedPointsData.clear();
    this.classifiedPointIndices.clear();
    this.classificationHistory = [];
    this.historyIndex = -1;
    this.fallbackWarningEmitted = false;
  }

  undo(): ClassificationChangeSummary | null {
    if (this.historyIndex < 0) {
      console.log('Nothing to undo');
      return null;
    }

    const entry = this.classificationHistory[this.historyIndex];
    console.log(`Undoing classification change from ${entry.timestamp.toISOString()}`);

    try {
      const deltaCounts = new Map<number, number>();

      entry.points.forEach(({ object, index, previousColor, previousClassification, newClassification }) => {
        const geometry = object.geometry as THREE.BufferGeometry;
        const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
        const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);

        if (colorAttribute) {
          colorAttribute.setXYZ(index, previousColor.r, previousColor.g, previousColor.b);
          colorAttribute.needsUpdate = true;
        }

        if (classificationAttribute) {
          const restoredValue = previousClassification ?? 0;
          classificationAttribute.setX(index, restoredValue);
          classificationAttribute.needsUpdate = true;
        }

        if (newClassification !== undefined) {
          deltaCounts.set(newClassification, (deltaCounts.get(newClassification) ?? 0) - 1);
        }

        if (previousClassification !== null && previousClassification !== undefined) {
          deltaCounts.set(previousClassification, (deltaCounts.get(previousClassification) ?? 0) + 1);
        }
      });

      this.historyIndex--;
      this.notifyChange();
      console.log(`✓ Undo complete. History: ${this.historyIndex + 1}/${this.classificationHistory.length}`);

      return {
        totalPoints: entry.points.length,
        deltas: Object.fromEntries(deltaCounts)
      };
    } catch (error) {
      console.error('Error during undo:', error);
      return null;
    }
  }

  redo(): ClassificationChangeSummary | null {
    if (this.historyIndex >= this.classificationHistory.length - 1) {
      console.log('Nothing to redo');
      return null;
    }

    this.historyIndex++;
    const entry = this.classificationHistory[this.historyIndex];
    console.log(`Redoing classification change from ${entry.timestamp.toISOString()}`);

    try {
      const deltaCounts = new Map<number, number>();

      entry.points.forEach(({ object, index, newColor, previousClassification, newClassification }) => {
        const geometry = object.geometry as THREE.BufferGeometry;
        const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
        const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);

        if (colorAttribute) {
          colorAttribute.setXYZ(index, newColor.r, newColor.g, newColor.b);
          colorAttribute.needsUpdate = true;
        }

        if (classificationAttribute) {
          classificationAttribute.setX(index, newClassification);
          classificationAttribute.needsUpdate = true;
        }

        if (previousClassification !== null && previousClassification !== undefined) {
          deltaCounts.set(previousClassification, (deltaCounts.get(previousClassification) ?? 0) - 1);
        }

        deltaCounts.set(newClassification, (deltaCounts.get(newClassification) ?? 0) + 1);
      });

      this.notifyChange();
      console.log(`✓ Redo complete. History: ${this.historyIndex + 1}/${this.classificationHistory.length}`);

      return {
        totalPoints: entry.points.length,
        deltas: Object.fromEntries(deltaCounts)
      };
    } catch (error) {
      console.error('Error during redo:', error);
      return null;
    }
  }

  canUndo(): boolean {
    return this.historyIndex >= 0;
  }

  canRedo(): boolean {
    return this.historyIndex < this.classificationHistory.length - 1;
  }

  clearHistory(): void {
    this.classificationHistory = [];
    this.historyIndex = -1;
    console.log('✓ Classification history cleared');
  }

  selectPointsInBox(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    screenWidth: number,
    screenHeight: number
  ): SelectedPoint[] {
    const camera = this.context.getCamera();
    const root = this.getPointCloudRoot();
    const selectedPoints: SelectedPoint[] = [];

    if (!camera || !root) {
      return selectedPoints;
    }

    try {
      const frustum = new THREE.Frustum();
      const projectionMatrix = new THREE.Matrix4();
      projectionMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionMatrix);

      const MAX_POINTS = Number.MAX_SAFE_INTEGER;
      const sourceId = this.resolveSourceId();

      root.traverse((child: any) => {
        if (selectedPoints.length >= MAX_POINTS) return;

        if (child.isPoints && child.geometry && child.visible) {
          const geometry = child.geometry as THREE.BufferGeometry;
          const positionAttribute = geometry.getAttribute('position');

          if (!positionAttribute) return;

          if (geometry.boundingBox) {
            const bbox = geometry.boundingBox.clone();
            bbox.applyMatrix4(child.matrixWorld);
            if (!frustum.intersectsBox(bbox)) return;
          }

          const worldMatrix = child.matrixWorld;
          const localPoint = new THREE.Vector3();
          const worldPoint = new THREE.Vector3();
          const screenPoint = new THREE.Vector3();

          const sampleRate = 1;

          for (let i = 0; i < positionAttribute.count; i += sampleRate) {
            if (selectedPoints.length >= MAX_POINTS) break;

            localPoint.fromBufferAttribute(positionAttribute, i);
            worldPoint.copy(localPoint).applyMatrix4(worldMatrix);

            if (!frustum.containsPoint(worldPoint)) continue;

            screenPoint.copy(worldPoint);
            screenPoint.project(camera);

            const pixelX = (screenPoint.x * 0.5 + 0.5) * screenWidth;
            const pixelY = (-(screenPoint.y * 0.5) + 0.5) * screenHeight;

            if (screenPoint.z < 1 && screenPoint.z > -1 &&
                pixelX >= minX && pixelX <= maxX &&
                pixelY >= minY && pixelY <= maxY) {
              // Check if point's classification is visible
              if (!this.shouldSelectPoint(child, i)) {
                continue;
              }

              const identifier = this.buildPointIdentifier(child, i, sourceId);
              if (!identifier) {
                continue;
              }

              selectedPoints.push({
                position: worldPoint.clone(),
                index: i,
                object: child,
                identifier
              });
            }
          }
        }
      });

      console.log(`✓ Box selection found ${selectedPoints.length} points`);
    } catch (error) {
      console.error('Error in box selection:', error);
    }

    return selectedPoints;
  }

  selectPointsInPolygon(
    polygonPoints: Array<{ x: number; y: number }>,
    screenWidth: number,
    screenHeight: number,
    options?: { sampleRate?: number }
  ): SelectedPoint[] {
    const camera = this.context.getCamera();
   const root = this.getPointCloudRoot();
    const selectedPoints: SelectedPoint[] = [];

    if (!camera || !root || polygonPoints.length < 3) {
      return selectedPoints;
    }

    try {
      const frustum = new THREE.Frustum();
      const projectionMatrix = new THREE.Matrix4();
      projectionMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionMatrix);

      const MAX_POINTS = Number.MAX_SAFE_INTEGER;
      const sourceId = this.resolveSourceId();

      root.traverse((child: any) => {
        if (selectedPoints.length >= MAX_POINTS) return;

        if (child.isPoints && child.geometry && child.visible) {
          const geometry = child.geometry as THREE.BufferGeometry;
          const positionAttribute = geometry.getAttribute('position');

          if (!positionAttribute) return;

          if (geometry.boundingBox) {
            const bbox = geometry.boundingBox.clone();
            bbox.applyMatrix4(child.matrixWorld);
            if (!frustum.intersectsBox(bbox)) return;
          }

          const worldMatrix = child.matrixWorld;
          const localPoint = new THREE.Vector3();
          const worldPoint = new THREE.Vector3();
          const screenPoint = new THREE.Vector3();

          const sampleRate = 1;

          for (let i = 0; i < positionAttribute.count; i += sampleRate) {
            if (selectedPoints.length >= MAX_POINTS) break;

            localPoint.fromBufferAttribute(positionAttribute, i);
            worldPoint.copy(localPoint).applyMatrix4(worldMatrix);

            if (!frustum.containsPoint(worldPoint)) continue;

            screenPoint.copy(worldPoint);
            screenPoint.project(camera);

            const pixelX = (screenPoint.x * 0.5 + 0.5) * screenWidth;
            const pixelY = (-(screenPoint.y * 0.5) + 0.5) * screenHeight;

            if (screenPoint.z < 1 && screenPoint.z > -1 &&
                this.isPointInPolygon(pixelX, pixelY, polygonPoints)) {
              // Check if point's classification is visible
              if (!this.shouldSelectPoint(child, i)) {
                continue;
              }

              const identifier = this.buildPointIdentifier(child, i, sourceId);
              if (!identifier) {
                continue;
              }

              selectedPoints.push({
                position: worldPoint.clone(),
                index: i,
                object: child,
                identifier
              });
            }
          }
        }
      });

      console.log(`✓ Polygon selection found ${selectedPoints.length} points (max: ${MAX_POINTS})`);
    } catch (error) {
      console.error('Error in polygon selection:', error);
    }

    return selectedPoints;
  }

  filterPointsByClassification(
    points: SelectedPoint[],
    classificationId: number | null | undefined,
    matchValues?: number[]
  ): SelectedPoint[] {
    const acceptedValues = new Set<number>();

    if (classificationId !== undefined && classificationId !== null) {
      acceptedValues.add(classificationId);
    }

    matchValues?.forEach(value => {
      if (value !== undefined && value !== null) {
        acceptedValues.add(value);
      }
    });

    if (acceptedValues.size === 0) {
      return points;
    }

    const filtered: SelectedPoint[] = [];

    points.forEach(point => {
      const geometry = point.object.geometry as THREE.BufferGeometry;
      if (!geometry) return;

      const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
      if (!classificationAttribute) return;

      const currentValue = classificationAttribute.getX(point.index);
      if (acceptedValues.has(currentValue)) {
        filtered.push(point);
      }
    });

    return filtered;
  }

  setClassificationOverrides(
    overrides: Record<string, Record<string, number>>,
    palette: Map<number, THREE.Color>,
    append: boolean = false
  ): void {
    if (!append) {
      this.pendingOverrides.clear();
    }

    Object.entries(overrides).forEach(([tileKey, pointMap]) => {
      const tileOverrides = append ? this.pendingOverrides.get(tileKey) ?? new Map<number, OverrideEntry>() : new Map<number, OverrideEntry>();

      Object.entries(pointMap).forEach(([indexString, classValue]) => {
        const pointIndex = Number(indexString);
        if (!Number.isFinite(pointIndex)) {
          return;
        }
        const color = palette.get(classValue) ?? this.overridePaletteFallback;
        tileOverrides.set(pointIndex, {
          classValue,
          color: color.clone()
        });
      });

      if (tileOverrides.size > 0) {
        this.pendingOverrides.set(tileKey, tileOverrides);
      }
    });

    this.applyPendingOverrides();
  }

  hasPendingOverrides(): boolean {
    return this.pendingOverrides.size > 0;
  }

  clearClassificationOverrides(): void {
    this.pendingOverrides.clear();
  }

  applyPendingOverrides(): number {
    if (this.pendingOverrides.size === 0) {
      return 0;
    }

    let applied = 0;

    this.pendingOverrides.forEach((pointOverrides, tileKey) => {
      const pointsNode = this.findPointsNodeByTileKey(tileKey);
      if (!pointsNode) {
        return;
      }

      const geometry = pointsNode.geometry as THREE.BufferGeometry;
      const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);

      if (!classificationAttribute) {
        return;
      }

      let classificationChanged = false;

      pointOverrides.forEach((entry, index) => {
        if (index >= classificationAttribute.count) {
          return;
        }

        const currentClass = classificationAttribute.getX(index);
        if (currentClass !== entry.classValue) {
          classificationAttribute.setX(index, entry.classValue);
          classificationChanged = true;
          applied++;
        }
      });

      if (classificationChanged) {
        classificationAttribute.needsUpdate = true;
      }
    });

    if (applied > 0) {
      this.notifyChange();
    }

    return applied;
  }

  applyClusterOverrides(
    overrides: Record<string, Record<string, number>>,
    palette: Map<number, THREE.Color>
  ): number {
    if (!overrides || Object.keys(overrides).length === 0) {
      this.clearClusterOverrides();
      return 0;
    }

    this.clearClusterOverrides();
    const backups = new Map<string, Map<number, ClusterOverrideBackupEntry>>();
    let applied = 0;

    Object.entries(overrides).forEach(([tileKey, pointMap]) => {
      const pointsNode = this.findPointsNodeByTileKey(tileKey);
      if (!pointsNode) {
        return;
      }

      const geometry = pointsNode.geometry as THREE.BufferGeometry;
      const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
      if (!classificationAttribute) {
        return;
      }
      const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
      const tileBackup = new Map<number, ClusterOverrideBackupEntry>();

      Object.entries(pointMap).forEach(([indexString, classValue]) => {
        const pointIndex = Number(indexString);
        if (!Number.isFinite(pointIndex) || pointIndex >= classificationAttribute.count) {
          return;
        }

        const previousClass = classificationAttribute.getX(pointIndex);
        const backupEntry: ClusterOverrideBackupEntry = { classification: previousClass };

        if (colorAttribute && pointIndex < colorAttribute.count) {
          backupEntry.color = new THREE.Color(
            colorAttribute.getX(pointIndex),
            colorAttribute.getY(pointIndex),
            colorAttribute.getZ(pointIndex)
          );
        }

        tileBackup.set(pointIndex, backupEntry);
        classificationAttribute.setX(pointIndex, classValue);

        if (colorAttribute) {
          const color = palette.get(classValue) ?? this.overridePaletteFallback;
          colorAttribute.setXYZ(pointIndex, color.r, color.g, color.b);
          colorAttribute.needsUpdate = true;
        }
        applied++;
      });

      if (tileBackup.size > 0) {
        backups.set(tileKey, tileBackup);
        classificationAttribute.needsUpdate = true;
      }
    });

    if (backups.size > 0) {
      this.clusterOverrideBackups = backups;
      this.notifyChange();
    }

    return applied;
  }

  clearClusterOverrides(): void {
    if (!this.clusterOverrideBackups) {
      return;
    }

    this.clusterOverrideBackups.forEach((pointMap, tileKey) => {
      const pointsNode = this.findPointsNodeByTileKey(tileKey);
      if (!pointsNode) {
        return;
      }
      const geometry = pointsNode.geometry as THREE.BufferGeometry;
      const classificationAttribute = this.getOrCreateClassificationAttribute(geometry);
      const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | null;
      if (!classificationAttribute) {
        return;
      }

      pointMap.forEach((backup, pointIndex) => {
        if (pointIndex >= classificationAttribute.count) {
          return;
        }
        classificationAttribute.setX(pointIndex, backup.classification);
        if (colorAttribute && pointIndex < colorAttribute.count && backup.color) {
          colorAttribute.setXYZ(pointIndex, backup.color.r, backup.color.g, backup.color.b);
        }
      });

      classificationAttribute.needsUpdate = true;
      if (colorAttribute) {
        colorAttribute.needsUpdate = true;
      }
    });

    this.clusterOverrideBackups = null;
    this.notifyChange();
  }

  private screenToWorldRadius(
    camera: THREE.Camera,
    screenRadius: number,
    distance: number
  ): number {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      return screenRadius;
    }

    try {
      const fov = camera.fov ?? 60;
      const worldHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(fov / 2));
      return (screenRadius / window.innerHeight) * worldHeight;
    } catch (error) {
      console.error('Error calculating world radius:', error);
      return screenRadius * 0.01;
    }
  }

  private queryRealPoints(
    root: THREE.Object3D,
    center: THREE.Vector3,
    radius: number,
    depth: number
  ): SelectedPoint[] {
    const selectedPoints: SelectedPoint[] = [];
    const MAX_POINTS = Number.MAX_SAFE_INTEGER;
    const sourceId = this.resolveSourceId();

    try {
      const selectionBox = new THREE.Box3();
      selectionBox.setFromCenterAndSize(center, new THREE.Vector3(radius * 2, radius * 2, depth));

      root.traverse((child: any) => {
        if (selectedPoints.length >= MAX_POINTS) return;

        if (child.isPoints && child.geometry && child.visible) {
          const geometry = child.geometry as THREE.BufferGeometry;
          const positionAttribute = geometry.getAttribute('position');

          if (!positionAttribute) return;

          if (geometry.boundingBox) {
            const bbox = geometry.boundingBox.clone();
            bbox.applyMatrix4(child.matrixWorld);
            if (!selectionBox.intersectsBox(bbox)) return;
          }

          const worldMatrix = child.matrixWorld;
          const localPoint = new THREE.Vector3();
          const worldPoint = new THREE.Vector3();

          const sampleRate = 1;

          for (let i = 0; i < positionAttribute.count; i += sampleRate) {
            if (selectedPoints.length >= MAX_POINTS) break;

            localPoint.fromBufferAttribute(positionAttribute, i);
            worldPoint.copy(localPoint).applyMatrix4(worldMatrix);

            if (!selectionBox.containsPoint(worldPoint)) continue;

            const distanceToCenter = worldPoint.distanceTo(center);

            if (distanceToCenter <= radius) {
              const zDistance = Math.abs(worldPoint.z - center.z);

              if (zDistance <= depth / 2) {
                // Check if point's classification is visible
                if (!this.shouldSelectPoint(child, i)) {
                  continue;
                }

                const identifier = this.buildPointIdentifier(child, i, sourceId);
                if (!identifier) {
                  continue;
                }

                selectedPoints.push({
                  position: worldPoint.clone(),
                  index: i,
                  object: child,
                  identifier
                });
              }
            }
          }
        }
      });

      console.log(`✓ Found ${selectedPoints.length} real points within selection volume`);
    } catch (error) {
      console.error('Error querying real points:', error);
    }

    return selectedPoints;
  }

  private addToHistory(entry: ClassificationHistoryEntry): void {
    if (this.historyIndex < this.classificationHistory.length - 1) {
      this.classificationHistory = this.classificationHistory.slice(0, this.historyIndex + 1);
    }

    this.classificationHistory.push(entry);
    this.historyIndex++;

    if (this.classificationHistory.length > this.MAX_HISTORY) {
      this.classificationHistory.shift();
      this.historyIndex--;
    }

    console.log(`History: ${this.historyIndex + 1}/${this.classificationHistory.length} entries`);
  }

  private getOrCreateClassificationAttribute(
    geometry: THREE.BufferGeometry
  ): THREE.BufferAttribute | null {
    const existingCapitalized = geometry.getAttribute('Classification') as THREE.BufferAttribute | null;
    const existingLowercase = geometry.getAttribute('classification') as THREE.BufferAttribute | null;

    let attribute: THREE.BufferAttribute | null = existingCapitalized ?? existingLowercase ?? null;

    if (!attribute) {
      const positionAttribute = geometry.getAttribute('position');
      if (!positionAttribute) {
        return null;
      }

      attribute = new THREE.BufferAttribute(new Float32Array(positionAttribute.count), 1);
    }

    // Ensure both attribute aliases point to the same buffer so Giro3D and our tools stay in sync.
    geometry.setAttribute('Classification', attribute);
    geometry.setAttribute('classification', attribute);

    return attribute;
  }

  private async initializeSelectionPreview(scene: THREE.Scene): Promise<void> {
    if (this.selectionPreviewSphere) {
      return;
    }

    try {
      const geometry = new THREE.SphereGeometry(1, 32, 32);
      const material = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.3,
        wireframe: true,
        depthTest: true,
        depthWrite: false
      });

      this.selectionPreviewSphere = new THREE.Mesh(geometry, material);
      this.selectionPreviewSphere.visible = false;
      this.selectionPreviewSphere.userData = { type: 'selection-preview' };

      scene.add(this.selectionPreviewSphere);
      console.log('✅ Initialized selection preview sphere');
    } catch (error) {
      console.error('Failed to initialize selection preview:', error);
    }
  }

  private async initializeClassificationLayer(scene: THREE.Scene): Promise<void> {
    if (this.classifiedPointsLayer) {
      return;
    }

    try {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.PointsMaterial({
        size: 6,
        vertexColors: true,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
        sizeAttenuation: true
      });

      this.classifiedPointsLayer = new THREE.Points(geometry, material);
      this.classifiedPointsLayer.userData = { type: 'classification-overlay' };
      this.classifiedPointsLayer.renderOrder = 1;

      scene.add(this.classifiedPointsLayer);
      console.log('✅ Initialized classification overlay layer');
    } catch (error) {
      console.error('Failed to initialize classification layer:', error);
    }
  }

  private async rebuildClassificationOverlay(): Promise<void> {
    if (!this.classifiedPointsLayer) {
      return;
    }

    try {
      const pointCount = this.classifiedPointsData.size;

      if (pointCount === 0) {
        this.classifiedPointsLayer.visible = false;
        return;
      }

      const positions = new Float32Array(pointCount * 3);
      const colors = new Float32Array(pointCount * 3);

      let index = 0;
      this.classifiedPointsData.forEach(({ position, color }) => {
        positions[index * 3] = position.x;
        positions[index * 3 + 1] = position.y;
        positions[index * 3 + 2] = position.z;

        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
        index++;
      });

      const geometry = this.classifiedPointsLayer.geometry as THREE.BufferGeometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();

      this.classifiedPointsLayer.visible = true;
      this.notifyChange();
    } catch (error) {
      console.error('Failed to rebuild classification overlay:', error);
    }
  }

  private async initializeClassificationPreview(scene: THREE.Scene): Promise<void> {
    if (this.classificationPreviewLayer) {
      return;
    }

    try {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.PointsMaterial({
        size: 3,
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      });

      this.classificationPreviewLayer = new THREE.Points(geometry, material);
      this.classificationPreviewLayer.visible = false;
      this.classificationPreviewLayer.renderOrder = 999;
      this.classificationPreviewLayer.userData = { type: 'classification-preview' };

      scene.add(this.classificationPreviewLayer);
    } catch (error) {
      console.error('Failed to initialize classification preview layer:', error);
    }
  }

  private isPointInPolygon(
    x: number,
    y: number,
    polygon: Array<{ x: number; y: number }>
  ): boolean {
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      const intersect = yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;

      if (intersect) inside = !inside;
    }

    return inside;
  }

  private getPointCloudRoot(): THREE.Object3D | null {
    const entity = this.context.getPointCloudEntity();
    return entity?.object3d ?? null;
  }

  private findPointsNodeByTileKey(tileKey: string): THREE.Points | null {
    const root = this.getPointCloudRoot();
    if (!root) {
      return null;
    }

    let match: THREE.Points | null = null;
    const normalizedKey = tileKey.trim();

    root.traverse((child: any) => {
      if (match || !child?.isPoints) {
        return;
      }

      const candidateKeys: Array<string | undefined> = [
        child.name,
        child.userData?.tileKey,
        child.userData?.key,
        child.userData?.id,
        child.userData?.nodeId,
        child.userData?.node?.id
      ];

      if (candidateKeys.some(key => key && key.toString().trim() === normalizedKey)) {
        match = child as THREE.Points;
      }
    });

    return match;
  }

  private notifyChange(): void {
    try {
      this.context.notifyChange();
    } catch (error) {
      console.warn('Failed to notify scene change:', error);
    }
  }
}
