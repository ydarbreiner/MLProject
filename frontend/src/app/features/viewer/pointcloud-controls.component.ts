import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';

@Component({
  selector: 'app-point-cloud-controls',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatCheckboxModule,
    MatSliderModule,
    MatSelectModule,
  ],
  templateUrl: './point-cloud-controls.component.html',
  styleUrls: ['./point-cloud-controls.component.scss'],
})
export class PointCloudControlsComponent {
  isExpanded = true;
  pointClouds = [
    { name: 'Point Cloud 1', visible: true, density: 100 },
    { name: 'Point Cloud 2', visible: false, density: 100 },
  ];
  selectedDensityMode = 'uniform';
  densityModes = [
    { value: 'uniform', label: 'Uniform Density' },
    { value: 'distance', label: 'Distance-based' },
  ];

  toggleExpanded() {
    this.isExpanded = !this.isExpanded;
  }

  onVisibilityChange(pc: any) {}
  onDensityChange(pc: any) {}
  onDensityModeChange() {}
}