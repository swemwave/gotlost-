const appData = window.APP_DATA || { scenes: [] };
const scenesData = Array.isArray(appData.scenes) ? appData.scenes : [];
const nameById = new Map(scenesData.map(scene => [scene.id, scene.name]));
const body = document.body;
const page = body?.dataset.page || 'pano';

setupFullscreenButtons();

if (page === 'pano') {
  initPanorama();
} else if (page === 'floor') {
  try {
    initFloorPlan();
  } catch (error) {
    console.error('Floor plan failed to load', error);
    const fallbackJson = document.querySelector('[data-floor-json]');
    const fallbackStats = document.querySelector('[data-floor-stats]');
    if (fallbackJson) {
      fallbackJson.textContent = 'Floor plan failed to load. Check console for details.';
    }
    if (fallbackStats) {
      fallbackStats.textContent = 'Floor plan failed to load.';
    }
  }
} else if (page === 'directory') {
  initDirectory();
}

function initPanorama() {
  const panoElement = document.querySelector('#pano');
  if (!panoElement || !window.Marzipano) {
    console.warn('Marzipano viewer missing');
    return;
  }

  const viewerOpts = {
    controls: {
      mouseViewMode: appData.settings?.mouseViewMode || 'drag'
    }
  };

  const viewer = new window.Marzipano.Viewer(panoElement, viewerOpts);
  const scenes = scenesData.map(data => createMarzipanoScene(viewer, data));
  const scenesById = new Map(scenes.map(scene => [scene.data.id, scene]));
  const sceneListElement = document.querySelector('[data-scene-list]');
  const sceneFilterInput = document.querySelector('[data-scene-filter]');
  const sceneNameElement = document.querySelector('[data-scene-name]');
  const autorotateButton = document.querySelector('[data-action="autorotate"]');
  const panelToggles = document.querySelectorAll('[data-toggle-panel]');
  const viewButtons = document.querySelectorAll('[data-view]');
  const directedAdjacency = buildDirectedAdjacency(scenesData);
  const routeStartSelect = document.querySelector('[data-route-start]');
  const routeDestSelect = document.querySelector('[data-route-dest]');
  const routePlanButton = document.querySelector('[data-route-plan]');
  const routeFollowButton = document.querySelector('[data-route-follow]');
  const routeResetButton = document.querySelector('[data-route-reset]');
  const routeStatus = document.querySelector('[data-route-status]');
  const routeStepsList = document.querySelector('[data-route-steps]');
  const routeUseCurrentButton = document.querySelector('[data-route-use-current]');
  const routeQuickMajorButton = document.querySelector('[data-route-quick-major]');
  const routeHud = document.querySelector('[data-route-hud]');
  const routeHudTarget = document.querySelector('[data-route-hud-target]');
  const routeHudArrow = document.querySelector('[data-route-hud-arrow]');
  const graph = buildGraphFromScenes(scenesData);
  const degreeById = new Map(graph.nodes.map(node => [node.id, node.degree]));
  const adjacency = directedAdjacency;
  const undirectedAdjacency = buildUndirectedAdjacency(graph.edges, graph.nodes);
  const checkpoints = scenesData.filter(isCheckpointScene);
  const majorStops = scenesData.filter(scene => isMajorStop(scene, degreeById.get(scene.id) || 0));
  let destinationMode = 'major';
  let activeRoute = null;
  let currentScene = null;
  let currentEntryView = null;
  let autorotateEnabled = false;

  const autorotate = window.Marzipano.autorotate({
    yawSpeed: 0.04,
    targetPitch: 0,
    targetFov: Math.PI / 2
  });

  renderSceneList();
  attachPanelEvents();
  attachViewControls();
  attachAutorotateButton();

  const startSceneId = new URLSearchParams(window.location.search).get('scene');
  const startingScene = (startSceneId && scenesById.get(startSceneId)) || scenes[0];
  if (startingScene) {
    switchScene(startingScene);
  }

  setupRouting();

  function createMarzipanoScene(viewer, data) {
    const urlPrefix = 'tiles';
    const source = window.Marzipano.ImageUrlSource.fromString(
      `${urlPrefix}/${data.id}/{z}/{f}/{y}/{x}.jpg`,
      { cubeMapPreviewUrl: `${urlPrefix}/${data.id}/preview.jpg` }
    );
    const geometry = new window.Marzipano.CubeGeometry(data.levels);
    const limiter = window.Marzipano.RectilinearView.limit.traditional(
      data.faceSize,
      100 * Math.PI / 180,
      120 * Math.PI / 180
    );
    const view = new window.Marzipano.RectilinearView(data.initialViewParameters, limiter);
    const scene = viewer.createScene({
      source,
      geometry,
      view,
      pinFirstLevel: true
    });

    const hotspots = [];

    (data.linkHotspots || []).forEach(hotspot => {
      const element = document.createElement('button');
      element.className = 'hotspot-link';
      element.dataset.targetId = hotspot.target;
      const arrow = document.createElement('span');
      arrow.className = 'hotspot-arrow';
      arrow.textContent = '>';
      const yawDegrees = hotspot.yaw * (180 / Math.PI);
      arrow.style.transform = `rotate(${yawDegrees}deg)`;
      const label = document.createElement('span');
      label.className = 'hotspot-label';
      const targetName = nameById.get(hotspot.target) || hotspot.target;
      label.textContent = targetName;
      element.appendChild(label);
      element.appendChild(arrow);
      element.title = `Go to ${targetName}`;
      element.setAttribute('aria-label', `Go to ${targetName}`);
      element.addEventListener('click', () => {
        const target = scenesById.get(hotspot.target);
        if (target) {
          switchScene(target, { fromSceneId: data.id });
        }
      });
      scene.hotspotContainer().createHotspot(element, { yaw: hotspot.yaw, pitch: hotspot.pitch });
      hotspots.push({ element, targetId: hotspot.target });
    });

    return { data, marzipanoScene: scene, view, hotspots };
  }

  function switchScene(scene, options = {}) {
    const fromSceneId = options.fromSceneId || currentScene?.data.id;
    const entryView = computeEntryView(scene, fromSceneId);
    scene.view.setParameters(entryView);
    currentScene = scene;
    currentEntryView = entryView;
    scene.marzipanoScene.switchTo();
    if (sceneNameElement) {
      sceneNameElement.textContent = scene.data.name;
    }
    updateActiveSceneButton();
    syncRouteToCurrentScene();
    updateRouteHud();
    updateHotspotRouteHints();
  }

  function computeEntryView(scene, fromSceneId) {
    const defaults = scene.data.initialViewParameters;
    if (!fromSceneId) return defaults;
    const incoming = (scene.data.linkHotspots || []).find(link => link.target === fromSceneId);
    if (!incoming) return defaults;
    const yaw = normalizeAngle((incoming.yaw ?? defaults.yaw) + Math.PI);
    const pitch = typeof incoming.pitch === 'number' ? incoming.pitch : defaults.pitch;
    return { yaw, pitch, fov: defaults.fov };
  }

  function renderSceneList(filter = '') {
    if (!sceneListElement) return;
    sceneListElement.innerHTML = '';
    const normalizedFilter = filter.trim().toLowerCase();
    const filteredScenes = scenes.filter(scene => {
      if (!normalizedFilter) return true;
      return scene.data.name.toLowerCase().includes(normalizedFilter);
    });

    if (!filteredScenes.length) {
      const li = document.createElement('li');
      li.textContent = 'No scenes found.';
      sceneListElement.appendChild(li);
      return;
    }

    filteredScenes.forEach(scene => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = scene.data.name;
      button.dataset.sceneId = scene.data.id;
      button.addEventListener('click', () => {
        switchScene(scene);
        closePanel();
      });
      li.appendChild(button);
      sceneListElement.appendChild(li);
    });
    updateActiveSceneButton();
  }

  function updateActiveSceneButton() {
    if (!sceneListElement || !currentScene) return;
    sceneListElement.querySelectorAll('button').forEach(button => {
      button.dataset.active = String(button.dataset.sceneId === currentScene.data.id);
    });
  }

  function attachPanelEvents() {
    if (!panelToggles.length) return;
    panelToggles.forEach(button => {
      button.addEventListener('click', () => {
        body.classList.toggle('panel-open');
      });
    });
  }

  function closePanel() {
    body.classList.remove('panel-open');
  }

  function attachViewControls() {
    viewButtons.forEach(button => {
      button.addEventListener('click', () => {
        if (!currentScene) return;
        const view = currentScene.view;
        const action = button.getAttribute('data-view');
        const yawStep = 0.3;
        const pitchStep = 0.25;
        const zoomStep = 0.35;
        switch (action) {
          case 'up':
            view.setPitch(view.pitch() + pitchStep);
            break;
          case 'down':
            view.setPitch(view.pitch() - pitchStep);
            break;
          case 'left':
            view.setYaw(view.yaw() - yawStep);
            break;
          case 'right':
            view.setYaw(view.yaw() + yawStep);
            break;
          case 'zoom-in':
            view.setFov(Math.max(view.fov() - zoomStep, 0.3));
            break;
          case 'zoom-out':
            view.setFov(Math.min(view.fov() + zoomStep, Math.PI));
            break;
          case 'reset':
            {
              const defaults = currentEntryView || currentScene.data.initialViewParameters;
              view.setYaw(defaults.yaw);
              view.setPitch(defaults.pitch);
              view.setFov(defaults.fov);
            }
            break;
          default:
            break;
        }
      });
    });
  }

  function attachAutorotateButton() {
    if (!autorotateButton) return;
    autorotateButton.addEventListener('click', () => {
      autorotateEnabled = !autorotateEnabled;
      if (autorotateEnabled) {
        viewer.startMovement(autorotate);
        autorotateButton.textContent = 'Stop rotate';
      } else {
        viewer.stopMovement();
        autorotateButton.textContent = 'Auto rotate';
      }
    });
  }

  function setupRouting() {
    if (!routeStartSelect || !routeDestSelect) return;
    populateStartOptions();
    populateDestinationOptions();
    setRouteStatus('Choose a start and destination to get a hop-by-hop path.');
    renderRouteSteps();
    updateRouteHud();
    updateHotspotRouteHints();
    updateRouteControls();

    routePlanButton?.addEventListener('click', planRoute);
    routeFollowButton?.addEventListener('click', followRoute);
    routeResetButton?.addEventListener('click', resetRoute);
    routeUseCurrentButton?.addEventListener('click', () => {
      if (!currentScene) return;
      const currentId = currentScene.data.id;
      const nextStart = isCheckpointScene(currentScene.data)
        ? currentId
        : findNearestCheckpoint(currentId);
      if (nextStart) {
        routeStartSelect.value = nextStart;
        setRouteStatus(`Start set to ${nameById.get(nextStart) || nextStart}.`);
      } else {
        setRouteStatus('No nearby checkpoint found from this view.');
      }
    });
    routeQuickMajorButton?.addEventListener('click', toggleDestinationMode);

    if (currentScene && isCheckpointScene(currentScene.data)) {
      routeStartSelect.value = currentScene.data.id;
    }
  }

  function populateStartOptions() {
    if (!routeStartSelect) return;
    const sorted = [...checkpoints].sort((a, b) => a.name.localeCompare(b.name));
    routeStartSelect.innerHTML = '<option value=\"\">Pick a checkpoint</option>';
    sorted.forEach(scene => {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.name;
      routeStartSelect.appendChild(option);
    });
  }

  function populateDestinationOptions() {
    if (!routeDestSelect) return;
    const previous = routeDestSelect.value;
    const pool =
      destinationMode === 'major'
        ? majorStops
        : scenesData.filter(scene => !isCheckpointScene(scene));
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    routeDestSelect.innerHTML = '<option value=\"\">Pick a destination</option>';
    sorted.forEach(scene => {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.name;
      routeDestSelect.appendChild(option);
    });
    if (previous && routeDestSelect.querySelector(`option[value=\"${previous}\"]`)) {
      routeDestSelect.value = previous;
    }
  }

  function toggleDestinationMode() {
    destinationMode = destinationMode === 'major' ? 'all' : 'major';
    if (routeQuickMajorButton) {
      routeQuickMajorButton.textContent =
        destinationMode === 'major' ? 'Show all stops' : 'Back to majors';
    }
    populateDestinationOptions();
    resetRoute({ keepSelections: true });
    setRouteStatus(destinationMode === 'major' ? 'Showing major stops only.' : 'Showing every stop.');
  }

  function planRoute() {
    const startId = routeStartSelect?.value;
    const destId = routeDestSelect?.value;
    if (!startId || !destId) {
      setRouteStatus('Pick both a checkpoint and a destination.');
      renderRouteSteps();
      return;
    }
    if (startId === destId) {
      setRouteStatus('Start and destination are the same. Choose a different target.');
      renderRouteSteps();
      return;
    }
    const path = shortestPath(adjacency, startId, destId);
    if (!path) {
      setRouteStatus('No route found between those stops.');
      renderRouteSteps();
      return;
    }
    activeRoute = {
      path,
      index: currentScene && currentScene.data.id === startId ? 1 : 0,
      startId,
      destId
    };
    updateRouteHud();
    updateHotspotRouteHints();
    renderRouteSteps(activeRoute);
    updateRouteControls();
    setRouteStatus(`Route ready (${path.length - 1} hops). Hit “Follow in viewer” to step through.`);
  }

  function followRoute() {
    if (!activeRoute) return;
    if (!activeRoute.path.length) return;

    syncIndexToCurrentScene();

    if (activeRoute.index >= activeRoute.path.length) {
      setRouteStatus('You are already at the destination.');
      updateRouteControls();
      renderRouteSteps(activeRoute);
      return;
    }

    const targetId = activeRoute.path[activeRoute.index];
    const fromSceneId =
      activeRoute.index > 0 ? activeRoute.path[activeRoute.index - 1] : currentScene?.data.id;
    const target = scenesById.get(targetId);
    if (!target) {
      setRouteStatus('Route target is missing from APP_DATA.');
      return;
    }
    switchScene(target, { fromSceneId });
    activeRoute.index += 1;
    const remaining = activeRoute.path.length - activeRoute.index;
    if (remaining > 0) {
      const nextId = activeRoute.path[activeRoute.index];
      setRouteStatus(`Move to ${nameById.get(nextId) || nextId}. (${remaining} stops left)`);
    } else {
      setRouteStatus('Arrived at destination.');
    }
    renderRouteSteps(activeRoute);
    updateRouteHud();
    updateHotspotRouteHints();
    updateRouteControls();
  }

  function resetRoute(options = {}) {
    const { keepSelections = false } = options;
    activeRoute = null;
    if (!keepSelections) {
      routeDestSelect.value = '';
    }
    renderRouteSteps();
    updateRouteHud();
    updateHotspotRouteHints();
    updateRouteControls();
    setRouteStatus('Route cleared. Pick a checkpoint and destination to get directions.');
  }

  function renderRouteSteps(route = null) {
    if (!routeStepsList) return;
    routeStepsList.innerHTML = '';
    if (!route || !route.path || !route.path.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Routing results will appear here.';
      routeStepsList.appendChild(li);
      return;
    }
    route.path.forEach((id, index) => {
      const li = document.createElement('li');
      const name = nameById.get(id) || id;
      const visited = index < route.index;
      const isNext = index === route.index;
      li.dataset.active = String(isNext);
      const prefix = index === 0 ? 'Start at' : visited ? 'Visited' : 'Walk to';
      li.textContent = `${prefix} ${name}`;
      routeStepsList.appendChild(li);
    });
  }

  function updateRouteControls() {
    if (!routeFollowButton) return;
    if (!activeRoute) {
      routeFollowButton.disabled = true;
      routeFollowButton.textContent = 'Follow in viewer';
      return;
    }
    const remaining = activeRoute.path.length - activeRoute.index;
    routeFollowButton.disabled = remaining <= 0;
    if (remaining <= 0) {
      routeFollowButton.textContent = 'Route complete';
    } else if (activeRoute.index === 0) {
      routeFollowButton.textContent = 'Start route';
    } else {
      routeFollowButton.textContent = `Next stop (${activeRoute.index}/${activeRoute.path.length - 1})`;
    }
  }

  function setRouteStatus(message) {
    if (!routeStatus) return;
    routeStatus.textContent = message;
  }

  function syncRouteToCurrentScene() {
    if (!currentScene) return;
    if (!routeStartSelect) return;

    if (isCheckpointScene(currentScene.data) && !routeStartSelect.value) {
      routeStartSelect.value = currentScene.data.id;
    }

    if (!activeRoute) return;
    syncIndexToCurrentScene();
    renderRouteSteps(activeRoute);
    updateRouteControls();
    updateRouteHud();
  }

  function findNearestCheckpoint(fromId) {
    if (!fromId) return null;
    const checkpointIds = new Set(checkpoints.map(scene => scene.id));

    const search = map => {
      if (!map.has(fromId)) return null;
      const queue = [fromId];
      const visited = new Set([fromId]);
      while (queue.length) {
        const node = queue.shift();
        if (checkpointIds.has(node)) return node;
        const neighbors = map.get(node) || [];
        neighbors.forEach(next => {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        });
      }
      return null;
    };

    return search(adjacency) || search(undirectedAdjacency) || null;
  }

  function syncIndexToCurrentScene() {
    if (!activeRoute || !currentScene) return;
    const currentId = currentScene.data.id;
    const idx = activeRoute.path.indexOf(currentId);
    if (idx >= 0) {
      activeRoute.index = Math.max(activeRoute.index, idx + 1);
    }
  }

  function updateRouteHud() {
    if (!routeHud || !routeHudTarget || !routeHudArrow) return;
    if (!activeRoute || !currentScene || activeRoute.index >= activeRoute.path.length) {
      routeHud.hidden = true;
      return;
    }
    const nextId = activeRoute.path[activeRoute.index];
    const nextName = nameById.get(nextId) || nextId;
    routeHud.hidden = false;
    routeHudTarget.textContent = nextName;
    const link = (currentScene.data.linkHotspots || []).find(h => h.target === nextId);
    const yawDeg = link ? link.yaw * (180 / Math.PI) : 0;
    routeHudArrow.style.transform = `rotate(${yawDeg}deg)`;
  }

  function updateHotspotRouteHints() {
    if (!currentScene || !currentScene.hotspots) return;
    const nextId = activeRoute && activeRoute.path ? activeRoute.path[activeRoute.index] : null;
    currentScene.hotspots.forEach(hs => {
      const state = nextId && hs.targetId === nextId ? 'next' : 'idle';
      hs.element.dataset.routeState = state;
      const label = hs.element.querySelector('.hotspot-label');
      if (label) {
        label.textContent = nameById.get(hs.targetId) || hs.targetId;
        label.dataset.active = String(state === 'next');
      }
    });
  }

  sceneFilterInput?.addEventListener('input', event => {
    renderSceneList(event.target.value);
  });
}

function initFloorPlan() {
  const svg = document.querySelector('[data-floor-plan]');
  const jsonBlock = document.querySelector('[data-floor-json]');
  const statsBlock = document.querySelector('[data-floor-stats]');
  const copyButton = document.querySelector('[data-copy-graph]');
  if (!svg) return;

  const graph = buildGraphFromScenes(scenesData);
  const layout = computeLayout(graph, { width: 920, height: 640 });

  renderHumanMap(svg, layout);
  renderComputerMap(jsonBlock, layout);
  renderStats(statsBlock, graph, layout);

  if (copyButton && jsonBlock) {
    copyButton.addEventListener('click', () => {
      const text = jsonBlock.textContent || '';
      if (!text.trim()) return;
      navigator.clipboard?.writeText(text).catch(() => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(jsonBlock);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('copy');
        selection.removeAllRanges();
      });
      copyButton.textContent = 'Copied!';
      setTimeout(() => (copyButton.textContent = 'Copy JSON'), 1400);
    });
  }

  function renderHumanMap(svgElement, layout) {
    const ns = 'http://www.w3.org/2000/svg';
    const { width, height, nodes, edges } = layout;
    svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgElement.innerHTML = '';

    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const zoneBands = [
      { zone: 'MB Wing', x: 0, width: width * 0.33, fill: 'rgba(95,243,193,0.06)', label: 'MB' },
      { zone: 'MC Wing', x: width * 0.33, width: width * 0.34, fill: 'rgba(95,215,255,0.06)', label: 'MC' },
      { zone: 'MD Wing', x: width * 0.67, width: width * 0.33, fill: 'rgba(205,156,255,0.06)', label: 'MD' }
    ];

    const grid = document.createElementNS(ns, 'g');
    grid.classList.add('plan-grid');
    const step = 80;
    for (let x = step; x < width; x += step) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', x);
      line.setAttribute('y1', 0);
      line.setAttribute('x2', x);
      line.setAttribute('y2', height);
      grid.appendChild(line);
    }
    for (let y = step; y < height; y += step) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('y1', y);
      line.setAttribute('x2', width);
      line.setAttribute('y2', y);
      grid.appendChild(line);
    }

    const bands = document.createElementNS(ns, 'g');
    bands.classList.add('plan-bands');
    zoneBands.forEach(band => {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', band.x);
      rect.setAttribute('y', 0);
      rect.setAttribute('width', band.width);
      rect.setAttribute('height', height);
      rect.setAttribute('fill', band.fill);
      bands.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.textContent = band.label;
      label.setAttribute('x', band.x + band.width / 2);
      label.setAttribute('y', 26);
      label.classList.add('plan-zone-label');
      bands.appendChild(label);
    });

    const linkGroup = document.createElementNS(ns, 'g');
    linkGroup.classList.add('plan-links');
    edges.forEach(edge => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', source.x);
      line.setAttribute('y1', source.y);
      line.setAttribute('x2', target.x);
      line.setAttribute('y2', target.y);
      line.classList.add('plan-link');
      linkGroup.appendChild(line);
    });

    const nodeGroup = document.createElementNS(ns, 'g');
    nodeGroup.classList.add('plan-nodes');
    nodes.forEach(node => {
      const g = document.createElementNS(ns, 'g');
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', node.x);
      circle.setAttribute('cy', node.y);
      circle.setAttribute('r', 9.5);
      circle.classList.add('plan-node');
      circle.style.fill = zoneColor(node.zone);
      const label = document.createElementNS(ns, 'text');
      label.textContent = node.name;
      label.setAttribute('x', node.x);
      label.setAttribute('y', node.y + 18);
      label.classList.add('plan-node-label');
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${node.name} • ${node.zone}`;
      circle.appendChild(title);
      g.appendChild(circle);
      g.appendChild(label);
      g.addEventListener('click', () => {
        window.location.href = `index.html?scene=${encodeURIComponent(node.id)}`;
      });
      nodeGroup.appendChild(g);
    });

    svgElement.appendChild(grid);
    svgElement.appendChild(bands);
    svgElement.appendChild(linkGroup);
    svgElement.appendChild(nodeGroup);
  }

  function renderComputerMap(target, layout) {
    if (!target) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      bounds: { width: layout.width, height: layout.height },
      nodes: layout.nodes.map(node => ({
        id: node.id,
        name: node.name,
        zone: node.zone,
        type: node.type,
        degree: node.degree,
        position: {
          x: round(node.x, 1),
          y: round(node.y, 1)
        }
      })),
      edges: layout.edges,
      directions: layout.directions
    };
    target.textContent = JSON.stringify(payload, null, 2);
  }

  function renderStats(target, graph, layout) {
    if (!target) return;
    const stats = graphStats(graph);
    const zoneCounts = graph.nodes.reduce((acc, node) => {
      acc[node.zone] = (acc[node.zone] || 0) + 1;
      return acc;
    }, {});
    target.innerHTML = `
      <div class="stat-grid">
        <div class="stat-pill"><strong>${stats.nodeCount}</strong><span>Stops</span></div>
        <div class="stat-pill"><strong>${stats.edgeCount}</strong><span>Connections</span></div>
        <div class="stat-pill"><strong>${stats.components}</strong><span>Components</span></div>
        <div class="stat-pill"><strong>${stats.maxDegree}</strong><span>Max degree</span></div>
        <div class="stat-pill"><strong>${stats.isolates}</strong><span>Isolated</span></div>
      </div>
      <p class="muted plan-note">Zones • MB: ${zoneCounts['MB Wing'] || 0} | MC: ${zoneCounts['MC Wing'] || 0} | MD: ${zoneCounts['MD Wing'] || 0} | Other: ${zoneCounts['Other'] || 0}</p>
      <p class="muted plan-note">Layout bounds ${layout.width}×${layout.height}. Coordinates stored above for computer-friendly parsing.</p>
    `;
  }
}

function initDirectory() {
  const listElement = document.querySelector('[data-directory-list]');
  const searchInput = document.querySelector('[data-directory-search]');
  const filterBar = document.querySelector('[data-filter-bar]');
  if (!listElement) return;

  const filterConfig = [
    { id: 'mb', label: 'MB wing', predicate: scene => detectZones(scene.name).includes('MB Wing') },
    { id: 'mc', label: 'MC wing', predicate: scene => detectZones(scene.name).includes('MC Wing') },
    { id: 'md', label: 'MD wing', predicate: scene => detectZones(scene.name).includes('MD Wing') },
    { id: 'checkpoint', label: 'Checkpoints', predicate: scene => categorizeScene(scene.name) === 'checkpoint' },
    { id: 'bridge', label: 'Bridges', predicate: scene => categorizeScene(scene.name) === 'bridge' }
  ];

  const activeFilters = new Set();
  renderFilters();
  renderList();

  searchInput?.addEventListener('input', renderList);

  function renderFilters() {
    if (!filterBar) return;
    filterBar.innerHTML = '';
    filterConfig.forEach(filter => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-pill';
      button.dataset.filterId = filter.id;
      button.dataset.active = 'false';
      button.textContent = filter.label;
      button.addEventListener('click', () => {
        if (activeFilters.has(filter.id)) {
          activeFilters.delete(filter.id);
        } else {
          activeFilters.add(filter.id);
        }
        button.dataset.active = String(activeFilters.has(filter.id));
        renderList();
      });
      filterBar.appendChild(button);
    });
  }

  function renderList() {
    listElement.innerHTML = '';
    const term = searchInput?.value.trim().toLowerCase() || '';
    const scenes = scenesData.filter(scene => {
      const matchesSearch = !term || scene.name.toLowerCase().includes(term);
      const matchesFilter = !activeFilters.size || Array.from(activeFilters).some(filterId => {
        const filter = filterConfig.find(item => item.id === filterId);
        return filter ? filter.predicate(scene) : true;
      });
      return matchesSearch && matchesFilter;
    });

    if (!scenes.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No stops match the current filters.';
      listElement.appendChild(p);
      return;
    }

    scenes.sort((a, b) => a.name.localeCompare(b.name));

    scenes.forEach(scene => {
      const card = document.createElement('article');
      card.className = 'stop-card';
      card.innerHTML = `
        <div>
          <p class="eyebrow">${detectZones(scene.name).join(' | ') || 'Shared zone'}</p>
          <h3>${scene.name}</h3>
        </div>
        <p class="muted">${describeScene(scene)}</p>
        <details>
          <summary>Connections (${scene.linkHotspots?.length || 0})</summary>
          <ul>${(scene.linkHotspots || []).map(link => `<li>${nameById.get(link.target) || link.target}</li>`).join('') || '<li>Terminal stop</li>'}</ul>
        </details>
      `;
      card.addEventListener('click', event => {
        if (event.target.closest('summary') || event.target.closest('details')) return;
        window.location.href = `index.html?scene=${encodeURIComponent(scene.id)}`;
      });
      listElement.appendChild(card);
    });
  }
}

function normalizeAngle(radians) {
  const twoPi = Math.PI * 2;
  let value = radians % twoPi;
  if (value <= -Math.PI) value += twoPi;
  if (value > Math.PI) value -= twoPi;
  return value;
}

function isCheckpointScene(scene) {
  return categorizeScene(scene.name) === 'checkpoint';
}

function isMajorStop(scene, degree = 0) {
  const type = categorizeScene(scene.name);
  if (type === 'checkpoint') return false;
  if (type !== 'general') return true;
  const keywords = [
    'heritage hall',
    'escalator',
    'stair',
    'entrance',
    'success',
    'experience',
    'walkway',
    'connector',
    'bridge'
  ];
  const value = scene.name.toLowerCase();
  if (keywords.some(term => value.includes(term))) return true;
  return degree >= 3;
}

function buildDirectedAdjacency(scenes) {
  const adjacency = new Map();
  scenes.forEach(scene => {
    const set = new Set();
    (scene.linkHotspots || []).forEach(link => {
      if (link.target) {
        set.add(link.target);
      }
    });
    adjacency.set(scene.id, set);
  });
  return adjacency;
}

function buildUndirectedAdjacency(edges, nodes = []) {
  const adjacency = new Map();
  nodes.forEach(node => {
    const id = typeof node === 'string' ? node : node.id;
    adjacency.set(id, new Set());
  });
  edges.forEach(edge => {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  });
  return adjacency;
}

function shortestPath(adjacency, startId, destId) {
  if (!startId || !destId) return null;
  if (!adjacency.has(startId) || !adjacency.has(destId)) return null;
  const queue = [startId];
  const visited = new Set([startId]);
  const parent = new Map();
  while (queue.length) {
    const node = queue.shift();
    if (node === destId) {
      const path = [];
      let current = destId;
      while (current !== undefined) {
        path.unshift(current);
        current = parent.get(current);
      }
      return path;
    }
    (adjacency.get(node) || []).forEach(next => {
      if (visited.has(next)) return;
      visited.add(next);
      parent.set(next, node);
      queue.push(next);
    });
  }
  return null;
}

function buildGraphFromScenes(scenes) {
  const nodes = scenes.map(scene => {
    const zone = detectZones(scene.name).find(tag => tag.includes('Wing')) || 'Other';
    return {
      id: scene.id,
      name: scene.name,
      zone,
      type: categorizeScene(scene.name),
      degree: 0
    };
  });
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const edges = [];
  const seen = new Set();
  const observations = [];

  scenes.forEach(scene => {
    (scene.linkHotspots || []).forEach(link => {
      if (!nodeMap.has(link.target)) return;
      const key = [scene.id, link.target].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source: scene.id, target: link.target });
      const a = nodeMap.get(scene.id);
      const b = nodeMap.get(link.target);
      if (a) a.degree += 1;
      if (b) b.degree += 1;
      observations.push({
        source: scene.id,
        target: link.target,
        yaw: normalizeAngle(link.yaw)
      });
    });
  });

  return { nodes, edges, observations };
}

function computeLayout(graph, options = {}) {
  const width = options.width || 900;
  const height = options.height || 640;
  const margin = 56;
  const nodes = graph.nodes.map(node => ({
    ...node,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: 0,
    fy: 0
  }));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const edges = graph.edges.map(edge => ({ ...edge }));
  const observations = graph.observations || [];
  const anchors = {
    'MB Wing': { x: -200, y: 100 },
    'MC Wing': { x: 40, y: 80 },
    'MD Wing': { x: 320, y: 60 },
    Other: { x: 0, y: 180 }
  };
  const jitter = () => (Math.random() - 0.5) * 30;

  nodes.forEach(node => {
    const anchor = anchors[node.zone] || anchors.Other;
    node.x = anchor.x + jitter();
    node.y = anchor.y + jitter();
  });

  const iterations = Math.min(900, Math.max(480, nodes.length * 32));
  const repulsion = 5200;
  const desiredLength = 140;
  const springK = 0.04;
  const damping = 0.86;
  const anchorPull = 0.0012;
  const directionPull = 0.11;

  for (let i = 0; i < iterations; i++) {
    nodes.forEach(node => {
      node.fx = 0;
      node.fy = 0;
    });

    // Directional constraints from hotspot yaws.
    observations.forEach(obs => {
      const source = nodeById.get(obs.source);
      const target = nodeById.get(obs.target);
      if (!source || !target) return;
      const tx = source.x + Math.cos(obs.yaw) * desiredLength;
      const ty = source.y + Math.sin(obs.yaw) * desiredLength;
      const fx = (tx - target.x) * directionPull;
      const fy = (ty - target.y) * directionPull;
      target.fx += fx;
      target.fy += fy;
      source.fx -= fx * 0.35;
      source.fy -= fy * 0.35;
    });

    // Edge length smoothing (undirected).
    edges.forEach(edge => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.max(Math.hypot(dx, dy), 1);
      const force = springK * (dist - desiredLength);
      const fx = force * (dx / dist);
      const fy = force * (dy / dist);
      source.fx += fx;
      source.fy += fy;
      target.fx -= fx;
      target.fy -= fy;
    });

    // Mild repulsion to keep nodes apart.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const na = nodes[a];
        const nb = nodes[b];
        const dx = nb.x - na.x;
        const dy = nb.y - na.y;
        const distSq = dx * dx + dy * dy + 0.01;
        const force = repulsion / distSq;
        const fx = force * dx;
        const fy = force * dy;
        na.fx -= fx;
        na.fy -= fy;
        nb.fx += fx;
        nb.fy += fy;
      }
    }

    // Gentle zone anchors.
    nodes.forEach(node => {
      const anchor = anchors[node.zone] || anchors.Other;
      node.fx += (anchor.x - node.x) * anchorPull;
      node.fy += (anchor.y - node.y) * anchorPull;
    });

    // Integrate.
    nodes.forEach(node => {
      node.vx = (node.vx + node.fx) * damping;
      node.vy = (node.vy + node.fy) * damping;
      node.x += node.vx;
      node.y += node.vy;
    });
  }

  // Rotate to align longest axis horizontally for readability.
  const rotated = rotateToPrincipal(nodes);
  const bounds = measureBounds(rotated);
  const scale = Math.min(
    (width - margin * 2) / Math.max(bounds.maxX - bounds.minX, 1),
    (height - margin * 2) / Math.max(bounds.maxY - bounds.minY, 1)
  );

  const normalized = rotated.map(node => ({
    ...node,
    x: (node.x - bounds.minX) * scale + margin,
    y: (node.y - bounds.minY) * scale + margin
  }));

  const cleanedNodes = normalized.map(({ vx, vy, fx, fy, ...rest }) => rest);
  const directions = observations.map(obs => ({
    source: obs.source,
    target: obs.target,
    yaw: round(obs.yaw, 4)
  }));
  return { width, height, nodes: cleanedNodes, edges, directions };
}

function graphStats(graph) {
  const degrees = graph.nodes.map(node => node.degree || 0);
  const adjacency = new Map(graph.nodes.map(node => [node.id, []]));
  graph.edges.forEach(edge => {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  });
  const visited = new Set();
  const components = [];
  graph.nodes.forEach(node => {
    if (visited.has(node.id)) return;
    const queue = [node.id];
    const members = [];
    visited.add(node.id);
    while (queue.length) {
      const current = queue.shift();
      members.push(current);
      (adjacency.get(current) || []).forEach(neighbor => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }
    components.push(members);
  });

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    components: components.length,
    largestComponent: components.reduce((max, comp) => Math.max(max, comp.length), 0),
    isolates: graph.nodes.filter(node => (node.degree || 0) === 0).length,
    avgDegree: degrees.length ? degrees.reduce((sum, val) => sum + val, 0) / degrees.length : 0,
    maxDegree: degrees.length ? Math.max(...degrees) : 0
  };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rotateToPrincipal(nodes) {
  const mean = nodes.reduce(
    (acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }),
    { x: 0, y: 0 }
  );
  mean.x /= nodes.length || 1;
  mean.y /= nodes.length || 1;
  const centered = nodes.map(node => ({
    ...node,
    x: node.x - mean.x,
    y: node.y - mean.y
  }));
  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  centered.forEach(node => {
    covXX += node.x * node.x;
    covYY += node.y * node.y;
    covXY += node.x * node.y;
  });
  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const sin = Math.sin(-angle);
  const cos = Math.cos(-angle);
  return centered.map(node => ({
    ...node,
    x: node.x * cos - node.y * sin,
    y: node.x * sin + node.y * cos
  }));
}

function measureBounds(nodes) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  nodes.forEach(node => {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  });
  return { minX, maxX, minY, maxY };
}

function detectZones(name) {
  const checks = [
    { pattern: /\bMB\b|MB\s|MB-/i, label: 'MB Wing' },
    { pattern: /\bMC\b|MC\s|MC-/i, label: 'MC Wing' },
    { pattern: /\bMD\b|MD\s|MD-/i, label: 'MD Wing' },
    { pattern: /bridge/i, label: 'Bridge' },
    { pattern: /washroom/i, label: 'Washroom' },
    { pattern: /heritage hall/i, label: 'Heritage Hall' }
  ];
  const tags = new Set();
  checks.forEach(({ pattern, label }) => {
    if (pattern.test(name)) {
      tags.add(label);
    }
  });
  return Array.from(tags);
}

function categorizeScene(name) {
  const value = name.toLowerCase();
  if (value.includes('check point') || value.includes('checkpoint')) return 'checkpoint';
  if (value.includes('bridge')) return 'bridge';
  if (value.includes('washroom')) return 'washroom';
  if (value.includes('study')) return 'study';
  if (value.includes('classroom')) return 'classroom';
  return 'general';
}

function describeScene(scene) {
  const type = categorizeScene(scene.name);
  const connectors = scene.linkHotspots || [];
  if (!connectors.length) {
    return `${typeLabel(type)} - terminal stop.`;
  }
  return `${typeLabel(type)} with ${connectors.length} connector${connectors.length === 1 ? '' : 's'}.`;
}

function typeLabel(type) {
  switch (type) {
    case 'checkpoint':
      return 'Checkpoint';
    case 'bridge':
      return 'Bridge';
    case 'washroom':
      return 'Washroom';
    case 'study':
      return 'Study area';
    case 'classroom':
      return 'Classroom';
    default:
      return 'Stop';
  }
}

function zoneColor(zone) {
  if (zone.includes('MB')) return '#5ff3c1';
  if (zone.includes('MC')) return '#5fd7ff';
  if (zone.includes('MD')) return '#c59cff';
  return '#9aa4c1';
}

function setupFullscreenButtons() {
  const buttons = document.querySelectorAll('[data-action="fullscreen"]');
  if (!buttons.length) return;
  const sf = window.screenfull;
  const targets = new Map();

  const isFullscreenFor = target => {
    if (sf && sf.isEnabled) {
      return sf.isFullscreen && sf.element === target;
    }
    return document.fullscreenElement === target;
  };

  const updateLabels = () => {
    buttons.forEach(button => {
      const target = targets.get(button);
      const active = target && isFullscreenFor(target);
      button.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    });
  };

  function toggleFullscreen(button) {
    const target = targets.get(button);
    if (!target) return;
    if (sf && sf.isEnabled) {
      if (sf.isFullscreen && sf.element === target) {
        sf.exit();
      } else {
        sf.request(target);
      }
    } else if (target.requestFullscreen) {
      if (document.fullscreenElement === target) {
        document.exitFullscreen?.();
      } else {
        target.requestFullscreen();
      }
    }
    setTimeout(updateLabels, 150);
  }

  buttons.forEach(button => {
    const selector = button.getAttribute('data-fullscreen-target');
    const target = selector ? document.querySelector(selector) : null;
    targets.set(button, target || document.documentElement);
    button.addEventListener('click', () => toggleFullscreen(button));
  });

  if (sf && sf.isEnabled) {
    sf.on('change', updateLabels);
  } else {
    document.addEventListener('fullscreenchange', updateLabels);
  }
  updateLabels();
}
