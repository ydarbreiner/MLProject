import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { PointCloud } from '../../../core/models/point-cloud.model';

@Component({
  selector: 'app-properties-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule
  ],
  templateUrl: './properties-panel.html',
  styleUrls: ['./properties-panel.scss']
})
export class PropertiesPanelComponent {
  @Input() pointCloud: PointCloud | null = null;

  isExpanded = true;

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
  }

  getTopClassifications(classification?: { [key: string]: number }): Array<{name: string, count: number, percentage: number}> {
    if (!classification) return [];

    const total = Object.values(classification).reduce((sum, count) => sum + count, 0);

    return Object.entries(classification)
      .map(([name, count]) => ({
        name,
        count,
        percentage: (count / total) * 100
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }
}