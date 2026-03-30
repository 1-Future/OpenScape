(function(exports) {
  exports.meta = {
    id: 'eraser',
    name: 'Eraser',
    version: '1.0.0',
    depends: [],
  };

  exports.server = {
    api: {},
    init(engine) { console.log('[eraser] Server ready'); },
  };

  exports.client = {
    api: {},
    init(engine) {
      const T = engine.T;
      let dragStart = null;
      let dragging = false;
      let preview = null; // {x, y, w, h}

      engine.registerTool({
        id: 'eraser',
        name: 'Eraser',
        icon: 'X',
        category: 'terrain',
        cursor: 'crosshair',
        keybind: { action: 'tool.eraser', key: 'e', label: 'Eraser', category: 'Build' },

        onActivate() { dragStart = null; dragging = false; preview = null; },
        onDeactivate() { dragStart = null; dragging = false; preview = null; },

        onMouseDown(e, tile, ctx) {
          dragStart = { x: tile.tx, y: tile.ty };
          dragging = true;
          preview = { x: tile.tx, y: tile.ty, w: 1, h: 1 };
          return true;
        },

        onMouseMove(e, tile, ctx) {
          if (!dragging || !dragStart) return;
          const minX = Math.min(dragStart.x, tile.tx), maxX = Math.max(dragStart.x, tile.tx);
          const minY = Math.min(dragStart.y, tile.ty), maxY = Math.max(dragStart.y, tile.ty);
          preview = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        },

        onMouseUp(e, tile, ctx) {
          if (!dragging || !preview) { dragging = false; return; }
          const { x, y, w, h } = preview;
          // Clear walls
          for (let ey = y; ey < y + h; ey++) {
            for (let ex = x; ex < x + w; ex++) {
              const wm = engine.getWallEdge(ex, ey);
              if (wm) engine.send({ t: 'wall_edge', x: ex, y: ey, mask: 0 });
              const dm = engine.getDoorEdge(ex, ey);
              if (dm) engine.send({ t: 'door_edge', x: ex, y: ey, mask: 0 });
              // Clear tile to water
              engine.setLocalTile(ex, ey, T.WATER);
              engine.setLocalColor(ex, ey, null);
              // Clear height
              engine.send({ t: 'set_height', x: ex, y: ey, h: 0 });
            }
          }
          // Send tile clear to server
          const tiles = [];
          for (let ey = y; ey < y + h; ey++)
            for (let ex = x; ex < x + w; ex++)
              tiles.push({ x: ex, y: ey, tile: T.WATER, color: null, variant: 0 });
          engine.send({ t: 'paint', tiles });
          engine.showChat(`Cleared ${w}x${h} area`, '#f44');
          dragging = false; dragStart = null; preview = null;
        },

        renderOverlay(ctx2d, cam) {
          if (!preview) return;
          const sx = (preview.x - cam.camX) * cam.TILE;
          const sy = (cam.camTopY - preview.y - preview.h + 1) * cam.TILE;
          const sw = preview.w * cam.TILE;
          const sh = preview.h * cam.TILE;
          ctx2d.fillStyle = 'rgba(255, 40, 40, 0.2)';
          ctx2d.fillRect(sx, sy, sw, sh);
          ctx2d.strokeStyle = 'rgba(255, 40, 40, 0.8)';
          ctx2d.lineWidth = 2;
          ctx2d.strokeRect(sx, sy, sw, sh);
          // Label
          ctx2d.font = 'bold 11px monospace';
          ctx2d.fillStyle = '#f44';
          ctx2d.fillText(`${preview.w}x${preview.h}`, sx + 4, sy + 14);
        },

        renderPanel(container) {
          container.innerHTML = '<div style="color:#f44;font-size:11px;padding:8px;">Drag on the map to erase walls, doors, and tiles in an area.</div>';
        },
      });

      console.log('[eraser] Client ready');
    },
  };
})(typeof module !== 'undefined' ? module.exports : (window.__plugins = window.__plugins || {}, window.__plugins['eraser'] = {}));
