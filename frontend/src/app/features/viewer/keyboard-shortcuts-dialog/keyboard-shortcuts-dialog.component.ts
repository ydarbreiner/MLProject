import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

@Component({
  selector: 'app-keyboard-shortcuts-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './keyboard-shortcuts-dialog.component.html',
  styleUrls: ['./keyboard-shortcuts-dialog.component.scss']
})
export class KeyboardShortcutsDialogComponent {
  shortcutGroups: ShortcutGroup[] = [
    {
      title: 'File Operations',
      shortcuts: [
        { keys: 'Ctrl+W', description: 'Close point cloud' },
        { keys: 'Ctrl+Shift+S', description: 'Export screenshot' }
      ]
    },
    {
      title: 'View Controls',
      shortcuts: [
        { keys: '1', description: 'RGB color mode' },
        { keys: '2', description: 'Elevation mode' },
        { keys: '3', description: 'Classification mode' },
        { keys: '4', description: 'Intensity mode' },
        { keys: 'Alt+1', description: 'Top view' },
        { keys: 'Alt+2', description: 'Front view' },
        { keys: 'Alt+3', description: 'Side view' },
        { keys: 'Alt+4', description: 'Isometric view' },
        { keys: 'R', description: 'Reset view' },
        { keys: 'F', description: 'Toggle fullscreen' },
        { keys: 'P', description: 'Toggle panels' },
        { keys: 'S', description: 'Toggle statistics' },
        { keys: 'G', description: 'Toggle grid' },
        { keys: 'X', description: 'Toggle axes' }
      ]
    },
    {
      title: 'Navigation',
      shortcuts: [
        { keys: '+', description: 'Zoom in' },
        { keys: '-', description: 'Zoom out' },
        { keys: 'Space+Drag', description: 'Pan' },
        { keys: 'Mouse Wheel', description: 'Zoom in/out' },
        { keys: 'Right Click+Drag', description: 'Rotate camera' }
      ]
    },
    {
      title: 'Tools',
      shortcuts: [
        { keys: 'M', description: 'Distance measurement' },
        { keys: 'I', description: 'Point info tool' },
        { keys: 'L', description: 'Lasso selection (classification mode)' },
        { keys: 'C', description: 'Classification editor' },
        { keys: 'Esc', description: 'Cancel current tool' }
      ]
    },
    {
      title: 'Editing',
      shortcuts: [
        { keys: 'Ctrl+Z', description: 'Undo (classification)' },
        { keys: 'Ctrl+Shift+Z', description: 'Redo (classification)' },
        { keys: 'Ctrl+,', description: 'Open preferences' }
      ]
    },
    {
      title: 'Display',
      shortcuts: [
        { keys: '[', description: 'Decrease point size' },
        { keys: ']', description: 'Increase point size' }
      ]
    },
    {
      title: 'Help',
      shortcuts: [
        { keys: '?', description: 'Show keyboard shortcuts' }
      ]
    }
  ];
}
