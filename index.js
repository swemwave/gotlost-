const appData = window.APP_DATA || { scenes: [] };
const scenesData = Array.isArray(appData.scenes) ? appData.scenes : [];
const nameById = new Map(scenesData.map(scene => [scene.id, scene.name]));
const body = document.body;
const page = body?.dataset.page || 'pano';

setupFullscreenButtons();

if (page === 'pano') {
  initPanorama();
} else if (page === 'floor') {
  initFloorPlan();
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
  let currentScene = null;
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

    (data.linkHotspots || []).forEach(hotspot => {
      const element = document.createElement('button');
      element.className = 'hotspot-link';
      const arrow = document.createElement('span');
      arrow.className = 'hotspot-arrow';
      arrow.textContent = '>';
      const yawDegrees = hotspot.yaw * (180 / Math.PI);
      arrow.style.transform = `rotate(${yawDegrees}deg)`;
      element.appendChild(arrow);
      const targetName = nameById.get(hotspot.target) || hotspot.target;
      element.title = `Go to ${targetName}`;
      element.setAttribute('aria-label', `Go to ${targetName}`);
      element.addEventListener('click', () => {
        const target = scenesById.get(hotspot.target);
        if (target) {
          switchScene(target);
        }
      });
      scene.hotspotContainer().createHotspot(element, { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });

    return { data, marzipanoScene: scene, view };
  }

  function switchScene(scene) {
    currentScene = scene;
    scene.marzipanoScene.switchTo();
    if (sceneNameElement) {
      sceneNameElement.textContent = scene.data.name;
    }
    updateActiveSceneButton();
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
            view.setYaw(currentScene.data.initialViewParameters.yaw);
            view.setPitch(currentScene.data.initialViewParameters.pitch);
            view.setFov(currentScene.data.initialViewParameters.fov);
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

  sceneFilterInput?.addEventListener('input', event => {
    renderSceneList(event.target.value);
  });
}

function initFloorPlan() {
  const svg = document.querySelector('[data-floor-plan]');
  if (!svg) return;
  const width = 600;
  const height = 600;
  const ns = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';
  const zones = ['MB Wing', 'MC Wing', 'MD Wing', 'Other'];
  const columns = {
    'MB Wing': width * 0.2,
    'MC Wing': width * 0.5,
    'MD Wing': width * 0.8,
    Other: width * 0.5
  };
  const grouped = new Map(zones.map(zone => [zone, []]));

  scenesData.forEach(scene => {
    const tags = detectZones(scene.name);
    const zone = tags.find(tag => tag.includes('Wing')) || 'Other';
    const bucket = grouped.get(zone) || grouped.get('Other');
    bucket.push({ scene, tags, zone });
  });

  const nodes = [];
  const margin = 80;
  zones.forEach(zone => {
    const entries = grouped.get(zone) || [];
    if (!entries.length) return;
    const total = entries.length;
    const spacing = total > 1 ? (height - margin * 2) / (total - 1) : 0;
    entries.forEach((entry, index) => {
      const y = total > 1 ? margin + index * spacing : height / 2;
      nodes.push({
        scene: entry.scene,
        tags: entry.tags,
        zone: entry.zone,
        x: columns[zone] ?? columns.Other,
        y
      });
    });
  });
  if (!nodes.length) return;

  const positionById = new Map(nodes.map(node => [node.scene.id, node]));
  const linkGroup = document.createElementNS(ns, 'g');
  const nodeGroup = document.createElementNS(ns, 'g');
  const seen = new Set();

  nodes.forEach(node => {
    (node.scene.linkHotspots || []).forEach(link => {
      const key = [node.scene.id, link.target].sort().join('|');
      if (seen.has(key) || !positionById.has(link.target)) return;
      seen.add(key);
      const target = positionById.get(link.target);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', node.x);
      line.setAttribute('y1', node.y);
      line.setAttribute('x2', target.x);
      line.setAttribute('y2', target.y);
      line.classList.add('plan-link');
      linkGroup.appendChild(line);
    });
  });

  nodes.forEach(node => {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', node.x);
    circle.setAttribute('cy', node.y);
    circle.setAttribute('r', 9);
    circle.classList.add('plan-node');
    circle.style.fill = zoneColor(node.zone);
    circle.addEventListener('click', () => {
      window.location.href = `index.html?scene=${encodeURIComponent(node.scene.id)}`;
    });
    nodeGroup.appendChild(circle);
  });

  svg.appendChild(linkGroup);
  svg.appendChild(nodeGroup);
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

function zoneRadius(zone) {
  if (zone.includes('MB')) return 0.4;
  if (zone.includes('MC')) return 0.6;
  if (zone.includes('MD')) return 0.8;
  return 0.5;
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
  buttons.forEach(button => {
    button.addEventListener('click', () => {
      const sf = window.screenfull;
      if (sf && sf.isEnabled) {
        sf.toggle(document.documentElement);
      } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    });
  });
}
