import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule
  ],
  templateUrl: './toolbar.html',
  styleUrls: ['./toolbar.scss']
})
export class ToolbarComponent {
  currentTool = 'select';

  onSelectTool(tool: string): void {
    this.currentTool = tool;
    // TODO: Apply tool selection
  }

  onMeasure(): void {
    this.onSelectTool('measure');
  }

  onAnnotate(): void {
    this.onSelectTool('annotate');
  }

  onSlice(): void {
    this.onSelectTool('slice');
  }

  onClip(): void {
    this.onSelectTool('clip');
  }
}