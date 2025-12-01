import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';

@Component({
  selector: 'app-scenarios-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatListModule
  ],
  templateUrl: './scenarios-panel.component.html',
  styleUrls: ['./scenarios-panel.component.scss']
})
export class ScenariosPanelComponent {
  scenarios = [
    { name: 'Default View', description: 'Standard point cloud visualization' },
    { name: 'Terrain Analysis', description: 'Enhanced ground classification' },
    { name: 'Building Detection', description: 'Focus on structure identification' },
    { name: 'Vegetation Study', description: 'Vegetation classification analysis' }
  ];

  selectedScenario = 0;

  onSelectScenario(index: number): void {
    this.selectedScenario = index;
    // TODO: Apply scenario settings
  }
}