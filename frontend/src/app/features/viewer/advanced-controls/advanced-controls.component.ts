import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FrustumCulledCOPCService } from '../../../core/services/frustum-culled-copc.service';
import { CameraSettings } from '../../../core/models/camera-settings.model';

@Component({
  selector: 'app-advanced-controls',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatSliderModule,
    MatSelectModule,
    MatFormFieldModule,
    MatCheckboxModule
  ],
  templateUrl: './advanced-controls.component.html',
  styleUrls: ['./advanced-controls.component.scss']
})
export class AdvancedControlsComponent {
  constructor(private copcService: FrustumCulledCOPCService) {}

  isExpanded = false;

  // Visualization controls
  pointSize = 2.0;
  pointBudget = '5000000';
  colorMode = 'rgb';

  // Quality controls
  edlEnabled = true;
  showBoundingBox = false;
  showHull = false;
  showStats = false;

  // Camera controls
  fov = 75;
  moveSpeed = 1.0;
  cameraSettings: CameraSettings = this.copcService.getCameraSettings();

  // Environment controls
  background = 'gradient';

  // Performance controls
  lodScale = 1.0;
  freezeLoading = false;

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
  }

  onPointSizeChange(value: number): void {
    this.pointSize = value;
    // TODO: Apply to point cloud renderer
  }

  onPointBudgetChange(event: any): void {
    this.pointBudget = event.value;
    // TODO: Apply to point cloud renderer
  }

  onColorModeChange(event: any): void {
    this.colorMode = event.value;
    // TODO: Apply to point cloud renderer
  }

  onEDLChange(event: any): void {
    this.edlEnabled = event.checked;
    // TODO: Apply to point cloud renderer
  }

  onBoundingBoxChange(event: any): void {
    this.showBoundingBox = event.checked;
    // TODO: Apply to point cloud renderer
  }

  onHullChange(event: any): void {
    this.showHull = event.checked;
    // TODO: Apply to point cloud renderer
  }

  onStatsChange(event: any): void {
    this.showStats = event.checked;
    // TODO: Apply to point cloud renderer
  }

  onFOVChange(value: number): void {
    this.fov = value;
    // TODO: Apply to camera
  }

  onMoveSpeedChange(value: number): void {
    this.moveSpeed = value;
    // TODO: Apply to controls
  }

  onRotationSensitivityChange(value: number): void {
    this.updateCameraSettings({ rotationSensitivity: Number(value) });
  }

  onPanSensitivityChange(value: number): void {
    this.updateCameraSettings({ panSensitivity: Number(value) });
  }

  onZoomSensitivityChange(value: number): void {
    this.updateCameraSettings({ zoomSensitivity: Number(value) });
  }

  onDampingToggle(checked: boolean): void {
    this.updateCameraSettings({ enableDamping: checked });
  }

  onDampingFactorChange(value: number): void {
    this.updateCameraSettings({ dampingFactor: Number(value) });
  }

  private updateCameraSettings(partial: Partial<CameraSettings>): void {
    this.copcService.updateCameraSettings(partial);
    this.cameraSettings = this.copcService.getCameraSettings();
  }

  onBackgroundChange(event: any): void {
    this.background = event.value;
    // TODO: Apply to scene
  }

  onLODScaleChange(value: number): void {
    this.lodScale = value;
    // TODO: Apply to point cloud renderer
  }

  onFreezeLoadingChange(event: any): void {
    this.freezeLoading = event.checked;
    // TODO: Apply to point cloud renderer
  }
}
