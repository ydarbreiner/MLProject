import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-navigation-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule
  ],
  templateUrl: './navigation-toolbar.component.html',
  styleUrls: ['./navigation-toolbar.component.scss']
})
export class NavigationToolbarComponent {
  onResetView(): void {
    // TODO: Reset camera view
  }

  onFitToView(): void {
    // TODO: Fit camera to point cloud bounds
  }

  onToggleFullscreen(): void {
    // TODO: Toggle fullscreen mode
  }

  onExportImage(): void {
    // TODO: Export current view as image
  }
}