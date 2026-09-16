// Data is shipped only as AES-256-GCM ciphertext (data.enc) and decrypted in the
// browser with a key the viewer supplies (URL fragment #key=... or pasted).
const ENCRYPTED_DATA_PATH = "./data.enc";
const KEY_SESSION_STORAGE = "chefNetworkKey";

const EDGE_COLORS = {
  influence_by_working_together: "#00e676",
  inspiration_no_working_together: "#ffd166",
  uncertain: "#ff4d6d",
  default: "#94a3b8"
};

const COMMUNITY_COLORS = [
  "#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa",
  "#fb7185", "#2dd4bf", "#fde047", "#38bdf8", "#f97316"
];

let cy;
let selectedCommunityMap = null;
let selectedNationalityMap = null;
let selectedCommunityMethod = null;
let edgeOpacityValue = 0.85;
let edgeWidthValue = 1.6;
let edgeColorMode = "influence_type";
let representativePartitionNodeMap = {};
let representativePartitionMeta = null;

if (typeof window !== "undefined") {
  const louvainExtension =
    window.cytoscapeLouvain ||
    (window.cytoscapeLouvain && window.cytoscapeLouvain.default);
  if (louvainExtension) {
    cytoscape.use(louvainExtension);
  }
}

const ui = {
  guideModeBtn: document.getElementById("guideModeBtn"),
  searchInput: document.getElementById("searchInput"),
  layoutSelect: document.getElementById("layoutSelect"),
  edgeTypeSelect: document.getElementById("edgeTypeSelect"),
  edgeColorModeSelect: document.getElementById("edgeColorModeSelect"),
  edgeOpacitySlider: document.getElementById("edgeOpacitySlider"),
  edgeOpacityValue: document.getElementById("edgeOpacityValue"),
  edgeWidthSlider: document.getElementById("edgeWidthSlider"),
  edgeWidthValue: document.getElementById("edgeWidthValue"),
  communityAlgoSelect: document.getElementById("communityAlgoSelect"),
  communityKInput: document.getElementById("communityKInput"),
  gccOnlyCheck: document.getElementById("gccOnlyCheck"),
  louvainGammaInput: document.getElementById("louvainGammaInput"),
  louvainRandomizeCheck: document.getElementById("louvainRandomizeCheck"),
  dagBinCountInput: document.getElementById("dagBinCountInput"),
  gammaSweepMinInput: document.getElementById("gammaSweepMinInput"),
  gammaSweepMaxInput: document.getElementById("gammaSweepMaxInput"),
  gammaSweepStepInput: document.getElementById("gammaSweepStepInput"),
  gammaSweepBtn: document.getElementById("gammaSweepBtn"),
  communityDefaultsBtn: document.getElementById("communityDefaultsBtn"),
  topKInput: document.getElementById("topKInput"),
  degreeModeSelect: document.getElementById("degreeModeSelect"),
  applyLayoutBtn: document.getElementById("applyLayoutBtn"),
  communitiesBtn: document.getElementById("communitiesBtn"),
  nationalityBtn: document.getElementById("nationalityBtn"),
  computeNationalityBtn: document.getElementById("computeNationalityBtn"),
  highlightTopKBtn: document.getElementById("highlightTopKBtn"),
  clearTopKBtn: document.getElementById("clearTopKBtn"),
  computeTopDegreeBtn: document.getElementById("computeTopDegreeBtn"),
  highlightTopDegreeBtn: document.getElementById("highlightTopDegreeBtn"),
  clearTopDegreeBtn: document.getElementById("clearTopDegreeBtn"),
  resetStyleBtn: document.getElementById("resetStyleBtn"),
  fitBtn: document.getElementById("fitBtn"),
  details: document.getElementById("chefDetails"),
  stats: document.getElementById("statsBox")
};

let tourState = {
  active: false,
  stepIndex: 0,
  overlayEl: null,
  pointerEl: null,
  tooltipEl: null
};

const TOUR_STEPS = [
  { selector: "#nationalityBtn", title: "Color by nationality", text: "Click this to color chef nodes by nationality." },
  { selector: "#searchInput", title: "Search a chef", text: "Type a chef name and click the node in the graph." },
  { selector: "#communityAlgoSelect", title: "Choose algorithm", text: "Set this to Label Propagation for the community demo." },
  { selector: "#communitiesBtn", title: "Run community detection", text: "This computes communities and colors nodes." },
  { selector: "#layoutSelect", title: "Select layout", text: "Choose 'Communities on ring' or 'Temporal (community bands)' here." },
  { selector: "#applyLayoutBtn", title: "Apply layout", text: "Click to apply the selected layout." },
  { selector: "#cy", title: "Graph interactions", text: "Click any chef to inspect their ego-network." },
  { selector: "#topKInput", title: "Live analytics", text: "Use top-k analytics on the right panel to inspect degree and nationality summaries." }
];

function base64UrlToBytes(text) {
  const b64 = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function decryptData(keyText) {
  if (!window.crypto?.subtle) {
    throw new Error("This browser does not support Web Crypto (use HTTPS and a modern browser).");
  }
  const response = await fetch(ENCRYPTED_DATA_PATH, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not download encrypted data (${response.status}).`);
  const bundle = await response.json();
  let rawKey;
  try {
    rawKey = base64UrlToBytes(keyText);
  } catch (error) {
    throw new Error("Key is not valid.");
  }
  if (rawKey.length !== 32) throw new Error("Key is not valid.");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(bundle.iv) },
      key,
      base64UrlToBytes(bundle.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (error) {
    throw new Error("Wrong key.");
  }
}

function indexRepresentativePartition(data) {
  representativePartitionMeta = null;
  representativePartitionNodeMap = {};
  if (!data || !Array.isArray(data.nodes)) {
    return;
  }
  representativePartitionMeta = {
    schema: data.schema,
    selection: data.selection,
    communitySizes: data.community_sizes
  };
  data.nodes.forEach((n) => {
    if (n && n.Id !== undefined && n.Id !== null) {
      representativePartitionNodeMap[String(n.Id)] = n;
    }
  });
}

function toElements(nodes, edges) {
  const nodeElements = nodes.map((n) => ({
    // Keep both DateOfBirth and parsed BirthYear for temporal layouts.
    data: {
      id: String(n.id),
      label: n.CanonicalName || `Chef ${n.id}`,
      name: n.CanonicalName || "",
      nationality: n.Nationality || "Unknown",
      nationalities: Array.isArray(n.Nationalities) ? n.Nationalities.join(", ") : "Unknown",
      dob: formatDateForDisplay(n.DateOfBirth),
      birthYear: extractBirthYear(n.DateOfBirth),
      indegree: Number(n.InDegree || 0),
      outdegree: Number(n.OutDegree || 0),
      totaldegree: Number(n.InDegree || 0) + Number(n.OutDegree || 0)
    }
  }));

  const edgeElements = edges.map((e, idx) => ({
    data: {
      id: `e-${idx}`,
      source: String(e.SourceID),
      target: String(e.TargetID),
      influenceType: e.InfluenceType || "unknown",
      sourceName: e.SourceCanonicalName || "",
      targetName: e.TargetCanonicalName || ""
    }
  }));

  return [...nodeElements, ...edgeElements];
}

function extractBirthYear(dateString) {
  if (!dateString || typeof dateString !== "string") {
    return null;
  }
  const match = dateString.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

function formatDateForDisplay(dateString) {
  if (!dateString || typeof dateString !== "string") {
    return "Unknown";
  }
  if (dateString.includes("T")) {
    return dateString.split("T")[0];
  }
  return dateString;
}

function baseStyle() {
  return [
    {
      selector: "node",
      style: {
        "background-color": "#38bdf8",
        label: "data(label)",
        "font-size": 9,
        color: "#e5e7eb",
        "text-opacity": 0.28,
        "text-outline-width": 2,
        "text-outline-color": "#0f172a",
        width: "mapData(totaldegree, 0, 35, 12, 45)",
        height: "mapData(totaldegree, 0, 35, 12, 45)"
      }
    },
    {
      selector: "edge",
      style: {
        width: () => edgeWidthValue,
        "line-color": (ele) => edgeColorForElement(ele),
        "target-arrow-color": (ele) => edgeColorForElement(ele),
        "line-style": (ele) => {
          const t = ele.data("influenceType");
          if (t === "inspiration_no_working_together") return "dashed";
          if (t === "uncertain") return "dotted";
          return "solid";
        },
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        opacity: () => edgeOpacityValue
      }
    },
    {
      selector: ".faded-node",
      style: {
        opacity: 0.1,
        "text-opacity": 0.03
      }
    },
    {
      selector: ".faded-edge",
      style: {
        opacity: 0.08
      }
    },
    {
      selector: ".highlighted",
      style: {
        "border-width": 3,
        "border-color": "#f8fafc",
        opacity: 1,
        "z-index": 999
      }
    },
    {
      selector: ".selected-node",
      style: {
        "text-opacity": 1,
        "font-size": 12,
        "border-width": 4,
        "border-color": "#f8fafc",
        "z-index": 1001
      }
    },
    {
      selector: ".neighbor-node",
      style: {
        "text-opacity": 1,
        "font-size": 10,
        "border-width": 2,
        "border-color": "#bae6fd",
        "z-index": 1000
      }
    },
    {
      selector: ".selected-edge",
      style: {
        width: 3.2,
        opacity: 1,
        "z-index": 998
      }
    },
    {
      selector: ".topk-nationality",
      style: {
        "border-width": 3,
        "border-color": "#fef08a",
        "overlay-opacity": 0.08,
        "overlay-color": "#fde047"
      }
    },
    {
      selector: ".topk-degree",
      style: {
        "border-width": 4,
        "border-color": "#f97316",
        "overlay-opacity": 0.1,
        "overlay-color": "#fb923c",
        width: "mapData(totaldegree, 0, 35, 14, 52)",
        height: "mapData(totaldegree, 0, 35, 14, 52)"
      }
    }
  ];
}

function getCommunityColorForNodeId(nodeId) {
  if (!selectedCommunityMap || Object.keys(selectedCommunityMap).length === 0) {
    return null;
  }
  const raw = selectedCommunityMap[nodeId];
  if (raw === undefined || raw === null) {
    return null;
  }
  const idx = Number(raw);
  if (!Number.isFinite(idx)) {
    return COMMUNITY_COLORS[0];
  }
  const c = ((idx % COMMUNITY_COLORS.length) + COMMUNITY_COLORS.length) % COMMUNITY_COLORS.length;
  return COMMUNITY_COLORS[c];
}

function edgeColorForElement(ele) {
  if (edgeColorMode === "source_community") {
    const c = getCommunityColorForNodeId(ele.source().id());
    return c || EDGE_COLORS.default;
  }
  if (edgeColorMode === "target_community") {
    const c = getCommunityColorForNodeId(ele.target().id());
    return c || EDGE_COLORS.default;
  }
  return EDGE_COLORS[ele.data("influenceType")] || EDGE_COLORS.default;
}

function refreshEdgeStyle() {
  if (!cy) {
    return;
  }
  if ((edgeColorMode === "source_community" || edgeColorMode === "target_community")
    && (!selectedCommunityMap || Object.keys(selectedCommunityMap).length === 0)) {
    const detection = ensureCommunitiesForLayouts();
    selectedCommunityMap = detection.map;
    selectedCommunityMethod = detection.method || selectedCommunityMethod;
  }

  cy.style()
    .selector("edge")
    .style({
      width: edgeWidthValue,
      "line-color": (ele) => edgeColorForElement(ele),
      "target-arrow-color": (ele) => edgeColorForElement(ele),
      "line-style": (ele) => {
        const t = ele.data("influenceType");
        if (t === "inspiration_no_working_together") return "dashed";
        if (t === "uncertain") return "dotted";
        return "solid";
      },
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      opacity: edgeOpacityValue
    })
    .selector(".faded-edge")
    .style({
      opacity: 0.08
    })
    .selector(".selected-edge")
    .style({
      opacity: 1,
      width: Math.max(3.2, edgeWidthValue + 1.4)
    })
    .update();
}

function makeLayout(name) {
  if (name === "cose") {
    return {
      name: "cose",
      animate: true,
      padding: 40,
      nodeRepulsion: 8000,
      idealEdgeLength: 120
    };
  }

  if (name === "concentric") {
    return {
      name: "concentric",
      animate: true,
      padding: 40,
      concentric: (node) => node.data("totaldegree"),
      levelWidth: () => 2
    };
  }

  if (name === "breadthfirst") {
    return {
      name: "breadthfirst",
      animate: true,
      directed: true,
      padding: 40,
      spacingFactor: 1.2
    };
  }

  if (name === "grid") {
    return {
      name: "grid",
      animate: true,
      padding: 40
    };
  }

  return {
    name: "circle",
    animate: true,
    padding: 40
  };
}

function seededRandom(seed) {
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function getCommunityMapForVisibleNodes() {
  return runCommunityDetectionAlgorithm("auto");
}

function getCommunityDetectionSubgraph() {
  const visibleNodes = cy.nodes(":visible").toArray();
  const visibleEdges = cy.edges(":visible").toArray();
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id()));
  if (!ui.gccOnlyCheck?.checked) {
    return {
      nodes: visibleNodes,
      edges: visibleEdges,
      excludedNodeIds: new Set(),
      scope: "visible-graph"
    };
  }

  const components = cy.elements(":visible").components();
  if (!components.length) {
    return {
      nodes: [],
      edges: [],
      excludedNodeIds: visibleNodeIds,
      scope: "gcc-only"
    };
  }

  const largest = components
    .map((comp) => comp.nodes().toArray())
    .sort((a, b) => b.length - a.length)[0] || [];
  const gccNodeIds = new Set(largest.map((n) => n.id()));
  const gccEdges = visibleEdges.filter((e) => gccNodeIds.has(e.source().id()) && gccNodeIds.has(e.target().id()));
  const excludedNodeIds = new Set([...visibleNodeIds].filter((id) => !gccNodeIds.has(id)));

  return {
    nodes: largest,
    edges: gccEdges,
    excludedNodeIds,
    scope: "gcc-only"
  };
}

function runLabelPropagationDetection() {
  const sub = getCommunityDetectionSubgraph();
  const visibleNodes = sub.nodes;
  if (!visibleNodes.length) {
    return { map: {}, method: "none", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
  }
  const subNodeIds = new Set(visibleNodes.map((n) => n.id()));
  const subEdges = sub.edges;
  const neighborsMap = {};
  visibleNodes.forEach((n) => {
    neighborsMap[n.id()] = [];
  });
  subEdges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (subNodeIds.has(u) && subNodeIds.has(v)) {
      neighborsMap[u].push(v);
      neighborsMap[v].push(u);
    }
  });

  const labels = {};
  visibleNodes.forEach((node) => {
    labels[node.id()] = node.id();
  });

  const maxIter = 30;
  for (let iter = 0; iter < maxIter; iter += 1) {
    let changes = 0;
    const order = visibleNodes
      .map((n, idx) => ({ n, r: seededRandom(iter * 997 + idx * 131 + 17) }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.n);

    order.forEach((node) => {
      const neighbors = (neighborsMap[node.id()] || []).map((nid) => ({ id: () => nid }));

      if (!neighbors.length) {
        return;
      }

      const freq = new Map();
      neighbors.forEach((nbr) => {
        const l = labels[nbr.id()];
        freq.set(l, (freq.get(l) || 0) + 1);
      });

      let bestLabel = labels[node.id()];
      let bestCount = -1;
      Array.from(freq.entries())
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .forEach(([lab, cnt]) => {
          if (cnt > bestCount) {
            bestLabel = lab;
            bestCount = cnt;
          }
        });

      if (labels[node.id()] !== bestLabel) {
        labels[node.id()] = bestLabel;
        changes += 1;
      }
    });

    if (changes === 0) {
      break;
    }
  }

  // Compact labels to numeric community ids.
  const compact = {};
  const remap = new Map();
  let next = 0;
  visibleNodes.forEach((node) => {
    const l = labels[node.id()];
    if (!remap.has(l)) {
      remap.set(l, next);
      next += 1;
    }
    compact[node.id()] = remap.get(l);
  });

  return { map: compact, method: "label-propagation", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
}

function runLouvainDetection() {
  const sub = getCommunityDetectionSubgraph();
  if (!sub.nodes.length) {
    return { map: {}, method: "none", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
  }
  const gamma = Number(ui.louvainGammaInput?.value ?? 1.0);
  const randomize = Boolean(ui.louvainRandomizeCheck?.checked);

  // Preferred path: Cytoscape Louvain extension (if available).
  if (typeof cy.louvain === "function") {
    const collection = cy.collection([...sub.nodes, ...sub.edges]);
    const options = {
      attributes: [{ name: "weight", type: "edge", value: () => 1 }],
      randomize
    };
    if (Number.isFinite(gamma) && gamma > 0) {
      options.resolution = gamma;
    }
    const result = collection.louvain(options);
    if (!result || !result.communities) {
      throw new Error("Louvain did not return communities.");
    }
    return {
      map: result.communities,
      method: `louvain-ext(gamma=${Number.isFinite(gamma) ? gamma.toFixed(2) : "1.00"}, randomize=${randomize ? "on" : "off"})`,
      scope: sub.scope,
      excludedNodeIds: sub.excludedNodeIds
    };
  }

  // Local fallback path: jlouvain library bundled with the app.
  if (typeof window !== "undefined" && typeof window.jLouvain === "function") {
    const nodeIds = sub.nodes.map((n) => n.id()).sort((a, b) => a.localeCompare(b));
    const undirectedEdgeWeights = new Map();
    sub.edges.forEach((e) => {
      const a = e.source().id();
      const b = e.target().id();
      if (a === b) return;
      const key = a < b ? `${a}__${b}` : `${b}__${a}`;
      undirectedEdgeWeights.set(key, (undirectedEdgeWeights.get(key) || 0) + 1);
    });
    const edgeList = Array.from(undirectedEdgeWeights.entries()).map(([key, weight]) => {
      const [source, target] = key.split("__");
      return { source, target, weight };
    });

    const solver = window.jLouvain()
      .nodes(nodeIds)
      .edges(edgeList)
      .resolution(gamma)
      .randomize(randomize);
    const communities = solver();
    return {
      map: communities || {},
      method: `jlouvain-local(gamma=${Number.isFinite(gamma) ? gamma.toFixed(2) : "1.00"}, randomize=${randomize ? "on" : "off"})`,
      scope: sub.scope,
      excludedNodeIds: sub.excludedNodeIds
    };
  }

  throw new Error("No Louvain implementation available (neither extension nor local jlouvain).");
}

function runWeakComponentsDetection() {
  const sub = getCommunityDetectionSubgraph();
  const nodes = sub.nodes;
  const edges = sub.edges;
  const ids = nodes.map((n) => n.id());
  const adj = {};
  ids.forEach((id) => { adj[id] = []; });
  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (adj[u] && adj[v]) {
      adj[u].push(v);
      adj[v].push(u);
    }
  });

  const map = {};
  let cid = 0;
  const seen = new Set();
  ids.forEach((start) => {
    if (seen.has(start)) return;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop();
      map[u] = cid;
      (adj[u] || []).forEach((v) => {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      });
    }
    cid += 1;
  });
  return { map, method: "weak-components", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
}

function runDagLayersDetection() {
  const sub = getCommunityDetectionSubgraph();
  const nodes = sub.nodes;
  const edges = sub.edges;
  const indeg = {};
  const adj = {};
  const level = {};
  nodes.forEach((n) => {
    indeg[n.id()] = 0;
    adj[n.id()] = [];
    level[n.id()] = 0;
  });
  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (u === v) return;
    adj[u].push(v);
    indeg[v] += 1;
  });

  const queue = [];
  Object.keys(indeg).forEach((id) => {
    if (indeg[id] === 0) queue.push(id);
  });

  let visited = 0;
  for (let qi = 0; qi < queue.length; qi += 1) {
    const u = queue[qi];
    visited += 1;
    adj[u].forEach((v) => {
      level[v] = Math.max(level[v], level[u] + 1);
      indeg[v] -= 1;
      if (indeg[v] === 0) queue.push(v);
    });
  }

  if (visited !== nodes.length) {
    throw new Error("Graph is not a DAG under current visible subgraph.");
  }
  return { map: level, method: "dag-layers", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
}

function computeDagLevelsFromSubgraph(sub) {
  const nodes = sub.nodes;
  const edges = sub.edges;
  const indeg = {};
  const adj = {};
  const level = {};
  nodes.forEach((n) => {
    indeg[n.id()] = 0;
    adj[n.id()] = [];
    level[n.id()] = 0;
  });
  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (!(u in adj) || !(v in indeg) || u === v) return;
    adj[u].push(v);
    indeg[v] += 1;
  });

  const queue = [];
  Object.keys(indeg).forEach((id) => {
    if (indeg[id] === 0) queue.push(id);
  });

  let visited = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const u = queue[i];
    visited += 1;
    adj[u].forEach((v) => {
      level[v] = Math.max(level[v], level[u] + 1);
      indeg[v] -= 1;
      if (indeg[v] === 0) queue.push(v);
    });
  }
  return { level, isDag: visited === nodes.length, adj, indeg };
}

function runDagLevelBinsDetection() {
  const sub = getCommunityDetectionSubgraph();
  if (!sub.nodes.length) {
    return { map: {}, method: "none", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
  }
  const { level, isDag } = computeDagLevelsFromSubgraph(sub);
  const values = Object.values(level);
  const minL = Math.min(...values);
  const maxL = Math.max(...values);
  const span = Math.max(1, maxL - minL + 1);
  const bins = Math.max(2, Math.min(20, Math.floor(Number(ui.dagBinCountInput?.value ?? 6))));
  const map = {};
  Object.entries(level).forEach(([id, l]) => {
    const norm = (l - minL) / span;
    map[id] = Math.min(bins - 1, Math.max(0, Math.floor(norm * bins)));
  });
  return {
    map,
    method: `dag-level-bins(k=${bins}${isDag ? "" : ", cyclic-fallback"})`,
    scope: sub.scope,
    excludedNodeIds: sub.excludedNodeIds
  };
}

function runDagSourceBasinDetection() {
  const sub = getCommunityDetectionSubgraph();
  if (!sub.nodes.length) {
    return { map: {}, method: "none", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
  }
  const nodes = sub.nodes;
  const edges = sub.edges;
  const indeg = {};
  const outAdj = {};
  nodes.forEach((n) => {
    indeg[n.id()] = 0;
    outAdj[n.id()] = [];
  });
  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (!(u in outAdj) || !(v in indeg) || u === v) return;
    outAdj[u].push(v);
    indeg[v] += 1;
  });

  const roots = Object.keys(indeg).filter((id) => indeg[id] === 0).sort((a, b) => a.localeCompare(b));
  if (!roots.length) {
    throw new Error("No source/root nodes found for DAG Source Basins.");
  }

  const best = {};
  Object.keys(indeg).forEach((id) => {
    best[id] = { root: null, dist: Infinity };
  });

  roots.forEach((root, rIdx) => {
    const queue = [{ id: root, dist: 0 }];
    const seen = new Set([root]);
    while (queue.length) {
      const { id, dist } = queue.shift();
      const candidate = best[id];
      if (dist < candidate.dist || (dist === candidate.dist && String(root) < String(candidate.root))) {
        best[id] = { root, dist };
      }
      outAdj[id].forEach((v) => {
        if (!seen.has(v)) {
          seen.add(v);
          queue.push({ id: v, dist: dist + 1 });
        }
      });
    }
  });

  const rootToCommunity = {};
  roots.forEach((root, idx) => {
    rootToCommunity[root] = idx;
  });

  const map = {};
  Object.entries(best).forEach(([id, b]) => {
    if (b.root === null) {
      map[id] = roots.length;
    } else {
      map[id] = rootToCommunity[b.root];
    }
  });

  return {
    map,
    method: `dag-source-basins(roots=${roots.length})`,
    scope: sub.scope,
    excludedNodeIds: sub.excludedNodeIds
  };
}

function runSbmApproxDetection(k = 6) {
  const sub = getCommunityDetectionSubgraph();
  const nodes = sub.nodes;
  if (!nodes.length) {
    return { map: {}, method: "none", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
  }
  const subNodeIds = new Set(nodes.map((n) => n.id()));
  const subEdges = sub.edges;
  const inMap = {};
  const outMap = {};
  const nbrMap = {};
  nodes.forEach((n) => {
    const id = n.id();
    inMap[id] = 0;
    outMap[id] = 0;
    nbrMap[id] = new Set();
  });
  subEdges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (!subNodeIds.has(u) || !subNodeIds.has(v)) return;
    outMap[u] += 1;
    inMap[v] += 1;
    nbrMap[u].add(v);
    nbrMap[v].add(u);
  });
  const kk = Math.max(2, Math.min(k, nodes.length));

  const features = nodes.map((node, idx) => {
    const id = node.id();
    const neighbors = Array.from(nbrMap[id] || []);
    const inDeg = inMap[id] || 0;
    const outDeg = outMap[id] || 0;
    const nbrInAvg = neighbors.length
      ? neighbors.reduce((s, nid) => s + (inMap[nid] || 0), 0) / neighbors.length
      : 0;
    const nbrOutAvg = neighbors.length
      ? neighbors.reduce((s, nid) => s + (outMap[nid] || 0), 0) / neighbors.length
      : 0;
    return {
      id,
      vec: [inDeg, outDeg, inDeg + outDeg, nbrInAvg, nbrOutAvg],
      idx
    };
  });

  // z-score normalize features
  const dims = features[0].vec.length;
  const means = Array(dims).fill(0);
  const stds = Array(dims).fill(0);
  features.forEach((f) => f.vec.forEach((v, d) => { means[d] += v; }));
  means.forEach((_, d) => { means[d] /= features.length; });
  features.forEach((f) => f.vec.forEach((v, d) => { stds[d] += (v - means[d]) ** 2; }));
  stds.forEach((_, d) => { stds[d] = Math.sqrt(stds[d] / Math.max(1, features.length - 1)) || 1; });
  features.forEach((f) => {
    f.vec = f.vec.map((v, d) => (v - means[d]) / stds[d]);
  });

  // k-means
  const centroids = [];
  for (let i = 0; i < kk; i += 1) {
    const pick = features[Math.floor(seededRandom(101 + i * 17) * features.length)];
    centroids.push([...pick.vec]);
  }

  const assign = Array(features.length).fill(0);
  for (let iter = 0; iter < 25; iter += 1) {
    let changed = 0;
    for (let i = 0; i < features.length; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < kk; c += 1) {
        let dist = 0;
        for (let d = 0; d < dims; d += 1) {
          const delta = features[i].vec[d] - centroids[c][d];
          dist += delta * delta;
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed += 1;
      }
    }

    const sums = Array.from({ length: kk }, () => Array(dims).fill(0));
    const counts = Array(kk).fill(0);
    for (let i = 0; i < features.length; i += 1) {
      const c = assign[i];
      counts[c] += 1;
      for (let d = 0; d < dims; d += 1) {
        sums[c][d] += features[i].vec[d];
      }
    }
    for (let c = 0; c < kk; c += 1) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dims; d += 1) {
        centroids[c][d] = sums[c][d] / counts[c];
      }
    }
    if (changed === 0) break;
  }

  const map = {};
  features.forEach((f, i) => {
    map[f.id] = assign[i];
  });
  return { map, method: "sbm-approx", scope: sub.scope, excludedNodeIds: sub.excludedNodeIds };
}

function runRepresentativePartitionDetection() {
  if (!representativePartitionNodeMap || !Object.keys(representativePartitionNodeMap).length) {
    throw new Error("Representative partition file not loaded (representative_partition_nodes.json).");
  }
  const sub = getCommunityDetectionSubgraph();
  const map = {};
  const missing = new Set();
  sub.nodes.forEach((node) => {
    const info = representativePartitionNodeMap[node.id()];
    if (info && info.Community !== undefined && info.Community !== null) {
      map[node.id()] = Number(info.Community);
    } else {
      missing.add(node.id());
    }
  });
  const experimentId = representativePartitionMeta?.selection?.experiment_id || "file";
  return {
    map,
    method: `representative-partition(${experimentId})`,
    scope: sub.scope,
    excludedNodeIds: new Set([...sub.excludedNodeIds, ...missing])
  };
}

function runCommunityDetectionAlgorithm(algo = "auto") {
  const selectedAlgo = String(algo || "auto");
  if (selectedAlgo === "representative_partition") {
    return runRepresentativePartitionDetection();
  }
  if (selectedAlgo === "louvain") {
    return runLouvainDetection();
  }
  if (selectedAlgo === "label_propagation") {
    return runLabelPropagationDetection();
  }
  if (selectedAlgo === "weak_components") {
    return runWeakComponentsDetection();
  }
  if (selectedAlgo === "dag_layers") {
    return runDagLayersDetection();
  }
  if (selectedAlgo === "dag_level_bins") {
    return runDagLevelBinsDetection();
  }
  if (selectedAlgo === "dag_source_basin") {
    return runDagSourceBasinDetection();
  }
  if (selectedAlgo === "sbm_approx") {
    const k = Number(ui.communityKInput?.value || 6);
    return runSbmApproxDetection(k);
  }

  // auto: Louvain -> label propagation
  try {
    return runLouvainDetection();
  } catch (error) {
    console.warn("Auto community detection: Louvain failed, fallback to label propagation.", error);
    return runLabelPropagationDetection();
  }
}

function computeUndirectedCommunityModularityQ(communityMap, nodes, edges, gamma = 1) {
  if (!communityMap || !nodes || !edges || !nodes.length) {
    return null;
  }

  const nodeIds = new Set(nodes.map((n) => n.id()));
  const degree = {};
  nodes.forEach((n) => {
    degree[n.id()] = 0;
  });

  // Build undirected weighted edges by summing reciprocal directed links.
  const undirWeights = new Map();
  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (!nodeIds.has(u) || !nodeIds.has(v) || u === v) {
      return;
    }
    const key = u < v ? `${u}__${v}` : `${v}__${u}`;
    undirWeights.set(key, (undirWeights.get(key) || 0) + 1);
  });

  let m = 0; // total undirected edge weight
  undirWeights.forEach((w, key) => {
    const [u, v] = key.split("__");
    degree[u] = (degree[u] || 0) + w;
    degree[v] = (degree[v] || 0) + w;
    m += w;
  });
  if (m <= 0) {
    return null;
  }

  const Kc = {}; // total degree per community
  nodes.forEach((n) => {
    const id = n.id();
    const c = communityMap[id];
    if (c === undefined || c === null) {
      return;
    }
    Kc[c] = (Kc[c] || 0) + (degree[id] || 0);
  });

  const Win = {}; // internal undirected edge weight per community
  undirWeights.forEach((w, key) => {
    const [u, v] = key.split("__");
    const cu = communityMap[u];
    const cv = communityMap[v];
    if (cu === undefined || cv === undefined || cu !== cv) {
      return;
    }
    Win[cu] = (Win[cu] || 0) + w;
  });

  const twoM = 2 * m;
  let q = 0;
  Object.keys(Kc).forEach((c) => {
    const wc = Win[c] || 0;
    const kc = Kc[c] || 0;
    q += wc / m - gamma * Math.pow(kc / twoM, 2);
  });
  return q;
}

function getFallbackComponentCommunityMap() {
  const fallback = {};
  const components = cy.elements(":visible").components();
  components.forEach((comp, idx) => {
    comp.nodes().forEach((node) => {
      fallback[node.id()] = idx;
    });
  });
  return fallback;
}

function getCommunityMapForLayouts() {
  if (selectedCommunityMap) {
    return selectedCommunityMap;
  }
  let detected;
  try {
    detected = runCommunityDetectionAlgorithm(ui.communityAlgoSelect?.value || "auto");
  } catch (error) {
    console.warn("Layout community detection fallback to weak components:", error);
    detected = runWeakComponentsDetection();
  }
  if (detected && detected.map && Object.keys(detected.map).length) {
    selectedCommunityMap = detected.map;
    selectedCommunityMethod = detected.method || "unknown";
    return detected.map;
  }
  return getFallbackComponentCommunityMap();
}

function ensureCommunitiesForLayouts() {
  if (selectedCommunityMap && Object.keys(selectedCommunityMap).length) {
    return { map: selectedCommunityMap, method: selectedCommunityMethod || "cached" };
  }
  let detected;
  try {
    detected = runCommunityDetectionAlgorithm(ui.communityAlgoSelect?.value || "auto");
  } catch (error) {
    console.warn("Community detection for layout failed, fallback to weak components:", error);
    detected = runWeakComponentsDetection();
  }
  selectedCommunityMap = detected.map || {};
  selectedCommunityMethod = detected.method || "unknown";
  return { map: selectedCommunityMap, method: selectedCommunityMethod };
}

function runPresetLayoutWithPositions(positions, fitPadding = 60) {
  cy.nodes().forEach((node) => {
    const p = positions[node.id()];
    if (p) {
      node.position({ x: p.x, y: p.y });
    }
  });
  cy.layout({ name: "preset", fit: true, padding: fitPadding, animate: true }).run();
}

function runFruchtermanReingoldLayout({ clustered = false, iterations = 140 } = {}) {
  const visibleNodes = cy.nodes(":visible");
  const visibleEdges = cy.edges(":visible");
  const n = visibleNodes.length;
  if (n === 0) {
    return;
  }

  const communityMap = clustered ? (selectedCommunityMap || getCommunityMapForVisibleNodes()) : null;
  const area = 1600 * 1000;
  const k = Math.sqrt(area / n);
  const tStart = 120;
  const positions = {};
  const nodesArray = visibleNodes.toArray();
  const edgesArray = visibleEdges.toArray();

  nodesArray.forEach((node, i) => {
    const p = node.position();
    positions[node.id()] = {
      x: Number.isFinite(p.x) ? p.x : (seededRandom(i + 1) - 0.5) * 800,
      y: Number.isFinite(p.y) ? p.y : (seededRandom(i + 97) - 0.5) * 800
    };
  });

  for (let iter = 0; iter < iterations; iter += 1) {
    const disp = {};
    nodesArray.forEach((node) => {
      disp[node.id()] = { x: 0, y: 0 };
    });

    // Repulsive forces (all pairs)
    for (let i = 0; i < nodesArray.length; i += 1) {
      for (let j = i + 1; j < nodesArray.length; j += 1) {
        const u = nodesArray[i].id();
        const v = nodesArray[j].id();
        const dx = positions[u].x - positions[v].x;
        const dy = positions[u].y - positions[v].y;
        const dist = Math.max(0.1, Math.hypot(dx, dy));
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[u].x += fx;
        disp[u].y += fy;
        disp[v].x -= fx;
        disp[v].y -= fy;
      }
    }

    // Attractive forces (edges)
    edgesArray.forEach((edge) => {
      const u = edge.source().id();
      const v = edge.target().id();
      const dx = positions[u].x - positions[v].x;
      const dy = positions[u].y - positions[v].y;
      const dist = Math.max(0.1, Math.hypot(dx, dy));
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[u].x -= fx;
      disp[u].y -= fy;
      disp[v].x += fx;
      disp[v].y += fy;
    });

    // Optional community pull to centroid (clustered mode).
    if (clustered && communityMap) {
      const groups = {};
      nodesArray.forEach((node) => {
        const c = String(communityMap[node.id()] ?? "0");
        if (!groups[c]) {
          groups[c] = [];
        }
        groups[c].push(node.id());
      });

      Object.values(groups).forEach((members) => {
        if (members.length < 2) {
          return;
        }
        const cx = members.reduce((s, id) => s + positions[id].x, 0) / members.length;
        const cy = members.reduce((s, id) => s + positions[id].y, 0) / members.length;
        members.forEach((id) => {
          const dx = cx - positions[id].x;
          const dy = cy - positions[id].y;
          disp[id].x += dx * 0.08;
          disp[id].y += dy * 0.08;
        });
      });
    }

    const temperature = tStart * (1 - iter / iterations);
    nodesArray.forEach((node) => {
      const id = node.id();
      const dx = disp[id].x;
      const dy = disp[id].y;
      const d = Math.max(0.1, Math.hypot(dx, dy));
      positions[id].x += (dx / d) * Math.min(d, temperature);
      positions[id].y += (dy / d) * Math.min(d, temperature);
    });
  }

  runPresetLayoutWithPositions(positions);
}

function runTemporalLayout(mode = "free") {
  const visibleNodes = cy.nodes(":visible").toArray();
  const visibleEdges = cy.edges(":visible").toArray();
  if (!visibleNodes.length) {
    return;
  }

  const years = visibleNodes.map((node) => node.data("birthYear")).filter((y) => Number.isFinite(y));
  const minYear = years.length ? Math.min(...years) : 1900;
  const maxYear = years.length ? Math.max(...years) : 2025;
  const yearRange = Math.max(1, maxYear - minYear);
  const xScale = 18;

  const positions = {};
  visibleNodes.forEach((node, i) => {
    const year = Number.isFinite(node.data("birthYear")) ? node.data("birthYear") : (minYear + maxYear) / 2;
    const x = (year - minYear - yearRange / 2) * xScale;
    const y = (seededRandom(i + 11) - 0.5) * 600;
    positions[node.id()] = { x, y };
  });

  // free_y: lightweight force simulation with x fixed at birth year.
  if (mode === "free") {
    const k = 80;
    for (let iter = 0; iter < 110; iter += 1) {
      const dispY = {};
      visibleNodes.forEach((node) => {
        dispY[node.id()] = 0;
      });

      for (let i = 0; i < visibleNodes.length; i += 1) {
        for (let j = i + 1; j < visibleNodes.length; j += 1) {
          const u = visibleNodes[i].id();
          const v = visibleNodes[j].id();
          const dy = positions[u].y - positions[v].y;
          const dist = Math.max(1, Math.abs(dy));
          const rep = (k * k) / dist;
          dispY[u] += rep * Math.sign(dy || 1);
          dispY[v] -= rep * Math.sign(dy || 1);
        }
      }

      visibleEdges.forEach((edge) => {
        const u = edge.source().id();
        const v = edge.target().id();
        const dy = positions[u].y - positions[v].y;
        const dist = Math.max(1, Math.abs(dy));
        const att = (dist * dist) / k;
        dispY[u] -= att * Math.sign(dy || 1);
        dispY[v] += att * Math.sign(dy || 1);
      });

      const temperature = 20 * (1 - iter / 110);
      visibleNodes.forEach((node) => {
        const id = node.id();
        const dy = dispY[id];
        positions[id].y += Math.max(-temperature, Math.min(temperature, dy * 0.002));
      });
    }
  } else {
    // bands: communities ordered by median birth year, akin to notebook band layout.
    const communityMap = getCommunityMapForLayouts();
    if (!communityMap) {
      // fallback to free if communities are unavailable
      runPresetLayoutWithPositions(positions);
      return;
    }
    const groups = {};
    visibleNodes.forEach((node) => {
      const c = String(communityMap[node.id()] ?? "0");
      if (!groups[c]) {
        groups[c] = [];
      }
      groups[c].push(node);
    });

    const orderedCommunities = Object.entries(groups)
      .map(([cid, members]) => {
        const memberYears = members
          .map((n) => n.data("birthYear"))
          .filter((y) => Number.isFinite(y))
          .sort((a, b) => a - b);
        const mid = memberYears.length ? memberYears[Math.floor(memberYears.length / 2)] : 1900;
        return { cid, members, medianYear: mid };
      })
      .sort((a, b) => a.medianYear - b.medianYear);

    // Use fixed-height non-overlapping bands so communities remain clearly isolated.
    const bandGap = 185;
    const innerBandHeight = bandGap * 0.68;
    orderedCommunities.forEach((group, gIdx) => {
      const center = (gIdx - (orderedCommunities.length - 1) / 2) * bandGap;
      const members = [...group.members].sort((a, b) => {
        const ax = Number.isFinite(a.data("birthYear")) ? a.data("birthYear") : 0;
        const bx = Number.isFinite(b.data("birthYear")) ? b.data("birthYear") : 0;
        return ax - bx || a.id().localeCompare(b.id());
      });

      members.forEach((node, i) => {
        const norm = members.length <= 1 ? 0.5 : i / (members.length - 1);
        const jitter = (seededRandom(gIdx * 1999 + i * 131 + 29) - 0.5) * 10;
        const local = (norm - 0.5) * innerBandHeight + jitter;
        positions[node.id()].y = center + local;
      });
    });
  }

  runPresetLayoutWithPositions(positions, 80);
}

function computeDagLayerLevels() {
  const nodes = cy.nodes(":visible").toArray();
  const edges = cy.edges(":visible").toArray();
  const indeg = {};
  const adj = {};
  const level = {};
  nodes.forEach((n) => {
    indeg[n.id()] = 0;
    adj[n.id()] = [];
    level[n.id()] = 0;
  });

  edges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    if (u === v || indeg[v] === undefined || adj[u] === undefined) {
      return;
    }
    adj[u].push(v);
    indeg[v] += 1;
  });

  const queue = [];
  Object.entries(indeg).forEach(([id, d]) => {
    if (d === 0) {
      queue.push(id);
    }
  });

  let visited = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const u = queue[i];
    visited += 1;
    adj[u].forEach((v) => {
      level[v] = Math.max(level[v], level[u] + 1);
      indeg[v] -= 1;
      if (indeg[v] === 0) {
        queue.push(v);
      }
    });
  }

  const isDag = visited === nodes.length;
  if (!isDag) {
    const maxLevel = Math.max(...Object.values(level), 0);
    let extra = 1;
    nodes.forEach((n) => {
      const id = n.id();
      if (indeg[id] > 0) {
        level[id] = maxLevel + extra;
        extra += 1;
      }
    });
  }

  return { level, isDag };
}

function runDagLayerTreeLayout(direction = "TB") {
  const nodes = cy.nodes(":visible").toArray();
  if (!nodes.length) {
    return;
  }

  const { level, isDag } = computeDagLayerLevels();
  const layers = {};
  nodes.forEach((node) => {
    const l = level[node.id()] || 0;
    if (!layers[l]) {
      layers[l] = [];
    }
    layers[l].push(node);
  });

  const layerKeys = Object.keys(layers).map(Number).sort((a, b) => a - b);
  const layerGap = 170;
  const nodeGap = 70;
  const positions = {};

  layerKeys.forEach((layerIdx) => {
    const members = layers[layerIdx].sort((a, b) => {
      const byDegree = b.outdegree(":visible") - a.outdegree(":visible");
      return byDegree || a.data("name").localeCompare(b.data("name"));
    });
    const offset = (members.length - 1) / 2;
    members.forEach((node, i) => {
      const along = (i - offset) * nodeGap;
      const across = layerIdx * layerGap;
      if (direction === "LR") {
        positions[node.id()] = { x: across, y: along };
      } else {
        positions[node.id()] = { x: along, y: across };
      }
    });
  });

  runPresetLayoutWithPositions(positions, 90);
  ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>DAG tree layout:</strong> ${direction}, layers=${layerKeys.length}, ${isDag ? "dag" : "cycles-detected fallback"}</div>`;
}

function runCommunityMacroLayout(variant = "ring") {
  const visibleNodes = cy.nodes(":visible").toArray();
  if (!visibleNodes.length) {
    return;
  }

  const communityMap = ensureCommunitiesForLayouts().map;
  const groups = {};
  visibleNodes.forEach((node) => {
    const cid = String(communityMap[node.id()] ?? "0");
    if (!groups[cid]) {
      groups[cid] = [];
    }
    groups[cid].push(node);
  });

  const communityEntries = Object.entries(groups)
    .map(([cid, members]) => ({ cid, members }))
    .sort((a, b) => b.members.length - a.members.length);

  const centers = {};
  const count = communityEntries.length;
  if (variant === "ring") {
    const radius = Math.max(340, 180 + count * 70);
    communityEntries.forEach((entry, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, count);
      centers[entry.cid] = {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle)
      };
    });
  } else {
    const cols = Math.ceil(Math.sqrt(count));
    const cell = 430;
    communityEntries.forEach((entry, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      centers[entry.cid] = {
        x: (col - (cols - 1) / 2) * cell,
        y: (row - (Math.ceil(count / cols) - 1) / 2) * cell
      };
    });
  }

  const positions = {};
  communityEntries.forEach((entry, cIdx) => {
    const center = centers[entry.cid];
    const members = entry.members;
    const localRadius = 40 + 10 * Math.sqrt(members.length);
    members.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, members.length);
      const jitter = (seededRandom(cIdx * 997 + i + 7) - 0.5) * 18;
      positions[node.id()] = {
        x: center.x + (localRadius + jitter) * Math.cos(angle),
        y: center.y + (localRadius + jitter) * Math.sin(angle)
      };
    });
  });

  runPresetLayoutWithPositions(positions, 90);
}

function runCommunityForceBlocksLayout() {
  const visibleNodes = cy.nodes(":visible").toArray();
  const visibleEdges = cy.edges(":visible").toArray();
  if (!visibleNodes.length) {
    return;
  }
  const detection = ensureCommunitiesForLayouts();
  const communityMap = detection.map;

  // 1) Place communities globally using ring centers weighted by size.
  const groups = {};
  visibleNodes.forEach((node) => {
    const cid = String(communityMap[node.id()] ?? "0");
    if (!groups[cid]) groups[cid] = [];
    groups[cid].push(node.id());
  });
  const entries = Object.entries(groups)
    .map(([cid, members]) => ({ cid, members }))
    .sort((a, b) => b.members.length - a.members.length);

  const centers = {};
  const radius = Math.max(360, 180 + entries.length * 75);
  entries.forEach((entry, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, entries.length);
    centers[entry.cid] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });

  // 2) Intra-community mini-force layout (FR-style) for better local structure.
  const positions = {};
  const edgesByCommunity = {};
  entries.forEach((entry) => {
    edgesByCommunity[entry.cid] = [];
  });
  visibleEdges.forEach((e) => {
    const u = e.source().id();
    const v = e.target().id();
    const cu = String(communityMap[u] ?? "0");
    const cv = String(communityMap[v] ?? "0");
    if (cu === cv && edgesByCommunity[cu]) {
      edgesByCommunity[cu].push([u, v]);
    }
  });

  entries.forEach((entry, cIdx) => {
    const cid = entry.cid;
    const members = entry.members;
    const localPos = {};
    members.forEach((id, i) => {
      localPos[id] = {
        x: (seededRandom(cIdx * 7919 + i * 53 + 3) - 0.5) * 120,
        y: (seededRandom(cIdx * 9151 + i * 67 + 5) - 0.5) * 120
      };
    });

    const area = Math.max(30000, members.length * 4500);
    const k = Math.sqrt(area / Math.max(1, members.length));
    const localEdges = edgesByCommunity[cid] || [];
    for (let iter = 0; iter < 70; iter += 1) {
      const disp = {};
      members.forEach((id) => {
        disp[id] = { x: 0, y: 0 };
      });

      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const u = members[i];
          const v = members[j];
          const dx = localPos[u].x - localPos[v].x;
          const dy = localPos[u].y - localPos[v].y;
          const dist = Math.max(0.1, Math.hypot(dx, dy));
          const force = (k * k) / dist;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          disp[u].x += fx;
          disp[u].y += fy;
          disp[v].x -= fx;
          disp[v].y -= fy;
        }
      }

      localEdges.forEach(([u, v]) => {
        const dx = localPos[u].x - localPos[v].x;
        const dy = localPos[u].y - localPos[v].y;
        const dist = Math.max(0.1, Math.hypot(dx, dy));
        const force = (dist * dist) / k;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[u].x -= fx;
        disp[u].y -= fy;
        disp[v].x += fx;
        disp[v].y += fy;
      });

      const temp = 25 * (1 - iter / 70);
      members.forEach((id) => {
        const dx = disp[id].x;
        const dy = disp[id].y;
        const d = Math.max(0.1, Math.hypot(dx, dy));
        localPos[id].x += (dx / d) * Math.min(d, temp);
        localPos[id].y += (dy / d) * Math.min(d, temp);
      });
    }

    const center = centers[cid];
    members.forEach((id) => {
      positions[id] = {
        x: center.x + localPos[id].x,
        y: center.y + localPos[id].y
      };
    });
  });

  runPresetLayoutWithPositions(positions, 100);
  ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community-aware layout:</strong> force blocks (${detection.method})</div>`;
}

function updateStats() {
  const visibleNodes = cy.nodes(":visible").length;
  const visibleEdges = cy.edges(":visible").length;
  const totalNodes = cy.nodes().length;
  const totalEdges = cy.edges().length;
  const edgeModeLabel =
    edgeColorMode === "source_community"
      ? "sender community"
      : edgeColorMode === "target_community"
        ? "receiver community"
        : "influence type";
  ui.stats.innerHTML = [
    `<div><strong>Visible chefs:</strong> ${visibleNodes} / ${totalNodes}</div>`,
    `<div><strong>Visible links:</strong> ${visibleEdges} / ${totalEdges}</div>`,
    `<div><strong>Link colors:</strong> <span style="color:${EDGE_COLORS.influence_by_working_together};">■</span> working together, <span style="color:${EDGE_COLORS.inspiration_no_working_together};">■</span> inspiration, <span style="color:${EDGE_COLORS.uncertain};">■</span> uncertain</div>`,
    `<div><strong>Edge mode:</strong> ${edgeModeLabel}; <strong>opacity:</strong> ${edgeOpacityValue.toFixed(2)}; <strong>width:</strong> ${edgeWidthValue.toFixed(2)}</div>`,
    `<div><strong>Tip:</strong> click a chef node to inspect details.</div>`
  ].join("");
}

function removeTourArtifacts() {
  document.querySelectorAll(".guide-target").forEach((el) => el.classList.remove("guide-target"));
  if (tourState.overlayEl) tourState.overlayEl.remove();
  if (tourState.pointerEl) tourState.pointerEl.remove();
  if (tourState.tooltipEl) tourState.tooltipEl.remove();
  tourState.overlayEl = null;
  tourState.pointerEl = null;
  tourState.tooltipEl = null;
}

function stopGuidedTour() {
  tourState.active = false;
  tourState.stepIndex = 0;
  removeTourArtifacts();
}

function renderTourStep() {
  if (!tourState.active) return;
  const step = TOUR_STEPS[tourState.stepIndex];
  const target = document.querySelector(step.selector);
  if (!target) return;

  document.querySelectorAll(".guide-target").forEach((el) => el.classList.remove("guide-target"));
  target.classList.add("guide-target");
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

  const rect = target.getBoundingClientRect();
  const pointerX = rect.left + rect.width * 0.5;
  const pointerY = rect.top + Math.min(rect.height * 0.5, 26);
  tourState.pointerEl.style.left = `${pointerX - 9}px`;
  tourState.pointerEl.style.top = `${pointerY - 9}px`;

  const tt = tourState.tooltipEl;
  const pad = 16;
  let left = rect.right + 14;
  let top = rect.top;
  if (left + 380 > window.innerWidth - pad) left = rect.left - 374;
  if (left < pad) left = pad;
  if (top + 170 > window.innerHeight - pad) top = window.innerHeight - 180;
  if (top < pad) top = pad;
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;

  tt.querySelector(".guide-tooltip-title").textContent = `${tourState.stepIndex + 1}. ${step.title}`;
  tt.querySelector(".guide-tooltip-text").textContent = step.text;
  tt.querySelector(".guide-prev").disabled = tourState.stepIndex === 0;
  tt.querySelector(".guide-next").textContent = tourState.stepIndex === TOUR_STEPS.length - 1 ? "Finish" : "Next";
}

function startGuidedTour() {
  stopGuidedTour();
  tourState.active = true;
  tourState.stepIndex = 0;

  const overlay = document.createElement("div");
  overlay.className = "guide-overlay";
  const pointer = document.createElement("div");
  pointer.className = "guide-pointer";
  const tooltip = document.createElement("div");
  tooltip.className = "guide-tooltip";
  tooltip.innerHTML = `
    <div class="guide-tooltip-title"></div>
    <div class="guide-tooltip-text"></div>
    <div class="guide-tooltip-controls">
      <button class="guide-prev" type="button">Back</button>
      <button class="guide-next" type="button">Next</button>
      <button class="guide-close" type="button">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.appendChild(pointer);
  document.body.appendChild(tooltip);
  tourState.overlayEl = overlay;
  tourState.pointerEl = pointer;
  tourState.tooltipEl = tooltip;

  tooltip.querySelector(".guide-prev").addEventListener("click", () => {
    if (tourState.stepIndex > 0) {
      tourState.stepIndex -= 1;
      renderTourStep();
    }
  });
  tooltip.querySelector(".guide-next").addEventListener("click", () => {
    if (tourState.stepIndex >= TOUR_STEPS.length - 1) {
      stopGuidedTour();
      return;
    }
    tourState.stepIndex += 1;
    renderTourStep();
  });
  tooltip.querySelector(".guide-close").addEventListener("click", () => {
    stopGuidedTour();
  });

  renderTourStep();
}

function getTopKValue() {
  const parsed = Number(ui.topKInput.value);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  return Math.max(1, Math.min(30, Math.floor(parsed)));
}

function computeNationalityCountsVisible() {
  const counts = new Map();
  cy.nodes(":visible").forEach((node) => {
    const nat = node.data("nationality") || "Unknown";
    counts.set(nat, (counts.get(nat) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderNationalityDistributionLive(topK = 5) {
  const distribution = computeNationalityCountsVisible();
  const totalVisible = distribution.reduce((acc, [, c]) => acc + c, 0) || 1;
  const top = distribution.slice(0, topK);
  const lines = top.map(([nat, c]) => {
    const pct = ((100 * c) / totalVisible).toFixed(1);
    return `• ${nat}: ${c} (${pct}%)`;
  });

  const more = distribution.length > top.length
    ? `<div class="muted">... +${distribution.length - top.length} more nationalities</div>`
    : "";

  ui.stats.innerHTML += `
    <div style="margin-top:8px;">
      <strong>Top ${topK} nationalities (visible):</strong><br/>
      ${lines.join("<br/>") || '<span class="muted">No visible nodes.</span>'}
      ${more}
    </div>
  `;
}

function clearTopKHighlight() {
  cy.nodes().removeClass("topk-nationality");
}

function clearTopDegreeHighlight() {
  cy.nodes().removeClass("topk-degree");
}

function getDegreeValue(node, mode) {
  if (mode === "in") {
    return node.indegree(":visible");
  }
  if (mode === "out") {
    return node.outdegree(":visible");
  }
  return node.connectedEdges(":visible").length;
}

function getDegreeModeLabel(mode) {
  if (mode === "in") return "in-degree";
  if (mode === "out") return "out-degree";
  return "total degree";
}

function computeTopDegreeVisible(topK = 5, mode = "in") {
  const rows = cy.nodes(":visible").map((node) => ({
    id: node.id(),
    name: node.data("name") || `Chef ${node.id()}`,
    value: getDegreeValue(node, mode),
    node
  }));
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return rows.slice(0, topK);
}

function renderTopDegreeLive(topK = 5, mode = "in") {
  const top = computeTopDegreeVisible(topK, mode);
  const label = getDegreeModeLabel(mode);
  const lines = top.map((r, idx) => `#${idx + 1} ${r.name}: ${r.value}`);
  ui.stats.innerHTML += `
    <div style="margin-top:8px;">
      <strong>Top ${topK} by ${label} (visible):</strong><br/>
      ${lines.join("<br/>") || '<span class="muted">No visible nodes.</span>'}
    </div>
  `;
}

function highlightTopKNationalities(topK = 5) {
  clearTopKHighlight();
  const distribution = computeNationalityCountsVisible();
  const topSet = new Set(distribution.slice(0, topK).map(([nat]) => nat));
  cy.nodes(":visible").forEach((node) => {
    const nat = node.data("nationality") || "Unknown";
    if (topSet.has(nat)) {
      node.addClass("topk-nationality");
    }
  });
  renderNationalityDistributionLive(topK);
}

function highlightTopDegree(topK = 5, mode = "in") {
  clearTopDegreeHighlight();
  const top = computeTopDegreeVisible(topK, mode);
  top.forEach((row) => row.node.addClass("topk-degree"));
  renderTopDegreeLive(topK, mode);
}

function renderChefDetails(node) {
  const escapeHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  const summarizeNames = (names, limit = 14) => {
    const shown = names.slice(0, limit).map((name) => `• ${escapeHtml(name)}`).join("<br/>");
    const more = names.length > limit ? `<br/>... +${names.length - limit} more` : "";
    if (!shown) {
      return '<span class="muted">none</span>';
    }
    return shown + more;
  };

  const d = node.data();
  const incoming = node.incomers("edge").length;
  const outgoing = node.outgoers("edge").length;
  const incomingNames = node.incomers("node").map((n) => n.data("name")).sort((a, b) => a.localeCompare(b));
  const outgoingNames = node.outgoers("node").map((n) => n.data("name")).sort((a, b) => a.localeCompare(b));
  const neighborSet = new Set([...incomingNames, ...outgoingNames]);
  const neighborNames = Array.from(neighborSet).sort((a, b) => a.localeCompare(b));

  const repInfo = representativePartitionNodeMap[d.id];
  const repBlock = repInfo
    ? `
    <hr style="border-color:#334155; opacity:0.6;" />
    <div class="item"><span class="muted">Representative community (file):</span> ${repInfo.Community}</div>
    <div class="item"><span class="muted">Ensemble node stability:</span> ${Number(repInfo.EnsembleNodeStability).toFixed(3)}</div>`
    : "";

  ui.details.innerHTML = `
    <div class="name"><strong>${escapeHtml(d.name)}</strong></div>
    <div class="item"><span class="muted">ID:</span> ${d.id}</div>
    <div class="item"><span class="muted">Nationality:</span> ${escapeHtml(d.nationality)}</div>
    <div class="item"><span class="muted">Nationalities:</span> ${escapeHtml(d.nationalities)}</div>
    <div class="item"><span class="muted">Date of birth:</span> ${escapeHtml(d.dob)}</div>
    <div class="item"><span class="muted">In-degree:</span> ${d.indegree}</div>
    <div class="item"><span class="muted">Out-degree:</span> ${d.outdegree}</div>
    <div class="item"><span class="muted">Incoming links:</span> ${incoming}</div>
    <div class="item"><span class="muted">Outgoing links:</span> ${outgoing}</div>
    <div class="item"><span class="muted">Total neighbors:</span> ${neighborNames.length}</div>
    <hr style="border-color:#334155; opacity:0.6;" />
    <div class="item"><span class="muted">Neighbors:</span><br/>${summarizeNames(neighborNames)}</div>
    <div class="item"><span class="muted">Incoming from:</span><br/>${summarizeNames(incomingNames, 10)}</div>
    <div class="item"><span class="muted">Outgoing to:</span><br/>${summarizeNames(outgoingNames, 10)}</div>
    ${repBlock}
  `;
}

function clearFocusClasses() {
  cy.elements().removeClass("faded-node faded-edge highlighted selected-node neighbor-node selected-edge");
}

function clearSelection() {
  clearFocusClasses();
  ui.details.innerHTML = "<p>Select a node to see details.</p>";
}

function filterByEdgeType(edgeType) {
  cy.edges().show();
  cy.nodes().show();

  if (edgeType === "all") {
    updateStats();
    return;
  }

  cy.edges().forEach((edge) => {
    if (edge.data("influenceType") !== edgeType) {
      edge.hide();
    }
  });

  cy.nodes().forEach((node) => {
    const hasVisibleConnection = node.connectedEdges(":visible").length > 0;
    if (!hasVisibleConnection) {
      node.hide();
    }
  });

  updateStats();
}

function applySearch(query) {
  const q = query.trim().toLowerCase();
  clearFocusClasses();

  if (!q) {
    return;
  }

  const matched = cy.nodes().filter((n) => n.data("name").toLowerCase().includes(q));
  if (!matched.length) {
    return;
  }

  cy.nodes(":visible").addClass("faded-node");
  cy.edges(":visible").addClass("faded-edge");
  matched.removeClass("faded-node").addClass("highlighted");
  matched.connectedEdges(":visible").removeClass("faded-edge").addClass("highlighted selected-edge");
  matched.connectedNodes(":visible").removeClass("faded-node").addClass("neighbor-node");
  cy.fit(matched.union(matched.connectedEdges()), 80);
}

function runModularityColoring() {
  const subgraphUsed = getCommunityDetectionSubgraph();
  let detected;
  const algo = ui.communityAlgoSelect?.value || "auto";
  try {
    detected = runCommunityDetectionAlgorithm(algo);
  } catch (error) {
    console.warn("Selected community algorithm failed. Falling back to weak components.", error);
    detected = runWeakComponentsDetection();
    ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community warning:</strong> ${error.message}</div>`;
  }
  const communities = detected.map || {};
  selectedCommunityMap = communities;
  selectedCommunityMethod = detected.method || "unknown";

  cy.nodes(":visible").forEach((node) => {
    const c = communities[node.id()];
    if (c === undefined || c === null) {
      node.style("background-color", "#475569");
      return;
    }
    const color = COMMUNITY_COLORS[Number(c) % COMMUNITY_COLORS.length];
    node.style("background-color", color || COMMUNITY_COLORS[0]);
  });

  const ids = new Set(Object.values(communities));
  const excludedCount = detected.excludedNodeIds ? detected.excludedNodeIds.size : 0;
  const qGamma = String(detected.method || "").includes("louvain")
    ? Number(ui.louvainGammaInput?.value ?? 1.0)
    : 1.0;
  const modularityQ = computeUndirectedCommunityModularityQ(
    communities,
    subgraphUsed.nodes || [],
    subgraphUsed.edges || [],
    Number.isFinite(qGamma) && qGamma > 0 ? qGamma : 1.0
  );
  ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Communities:</strong> ${ids.size} (<span class="muted">${detected.method}</span>, ${detected.scope || "visible-graph"})</div>`;
  if (modularityQ !== null) {
    ui.stats.innerHTML += `<div><strong>Modularity Q:</strong> ${modularityQ.toFixed(4)}${String(detected.method || "").includes("louvain") ? ` (gamma=${(Number.isFinite(qGamma) && qGamma > 0 ? qGamma : 1).toFixed(2)})` : ""}</div>`;
  } else {
    ui.stats.innerHTML += `<div class="muted">Modularity Q unavailable for current subgraph.</div>`;
  }
  const isRepresentativePartition = String(detected.method || "").startsWith("representative-partition");
  if (excludedCount > 0) {
    const excludedLabel = isRepresentativePartition ? "Not covered by loaded partition file" : "Excluded outside GCC";
    ui.stats.innerHTML += `<div class="muted">${excludedLabel}: ${excludedCount} nodes (colored gray).</div>`;
  }
  if (isRepresentativePartition && representativePartitionMeta?.selection) {
    const sel = representativePartitionMeta.selection;
    const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
    ui.stats.innerHTML += `
      <div class="muted" style="margin-top:4px;">
        Selection: ${sel.selection_method || "n/a"} &middot; experiment ${sel.experiment_id || "n/a"}<br/>
        DAG modularity: ${fmt(sel.dag_modularity_resolution, 4)} &middot;
        mean ARI ${fmt(sel.mean_ari_to_other_runs)} &middot;
        mean NMI ${fmt(sel.mean_nmi_to_other_runs)} &middot;
        mean ECS ${fmt(sel.mean_ecs_to_other_runs)}
      </div>`;
  }
}

function restoreCommunitySettingsDefaults() {
  if (ui.louvainGammaInput) {
    ui.louvainGammaInput.value = "1.0";
  }
  if (ui.louvainRandomizeCheck) {
    ui.louvainRandomizeCheck.checked = true;
  }
  if (ui.dagBinCountInput) {
    ui.dagBinCountInput.value = "6";
  }
  if (ui.gammaSweepMinInput) {
    ui.gammaSweepMinInput.value = "0.2";
  }
  if (ui.gammaSweepMaxInput) {
    ui.gammaSweepMaxInput.value = "3.0";
  }
  if (ui.gammaSweepStepInput) {
    ui.gammaSweepStepInput.value = "0.2";
  }
  ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community settings:</strong> restored defaults (gamma=1.0, randomize=on, bins=6)</div>`;
}

function runGammaSweepAndReportQ() {
  const minG = Number(ui.gammaSweepMinInput?.value);
  const maxG = Number(ui.gammaSweepMaxInput?.value);
  const stepG = Number(ui.gammaSweepStepInput?.value);
  if (!Number.isFinite(minG) || !Number.isFinite(maxG) || !Number.isFinite(stepG) || stepG <= 0 || maxG < minG) {
    ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Gamma sweep error:</strong> invalid min/max/step values.</div>`;
    return;
  }

  const previousGamma = ui.louvainGammaInput?.value ?? "1.0";
  const sub = getCommunityDetectionSubgraph();
  const lines = [];
  let best = null;

  for (let g = minG; g <= maxG + 1e-9; g += stepG) {
    const gamma = Number(g.toFixed(6));
    if (ui.louvainGammaInput) {
      ui.louvainGammaInput.value = gamma.toFixed(2);
    }
    try {
      const detected = runLouvainDetection();
      const communities = detected.map || {};
      const q = computeUndirectedCommunityModularityQ(
        communities,
        sub.nodes || [],
        sub.edges || [],
        gamma
      );
      const cCount = new Set(Object.values(communities)).size;
      const qLabel = q === null ? "n/a" : q.toFixed(4);
      lines.push(`gamma=${gamma.toFixed(2)} -> communities=${cCount}, Q=${qLabel}`);
      if (q !== null && (!best || q > best.q)) {
        best = { gamma, q, cCount };
      }
    } catch (error) {
      lines.push(`gamma=${gamma.toFixed(2)} -> error: ${error.message}`);
    }
  }

  if (ui.louvainGammaInput) {
    ui.louvainGammaInput.value = previousGamma;
  }

  const bestLine = best
    ? `<div><strong>Best Q:</strong> gamma=${best.gamma.toFixed(2)}, Q=${best.q.toFixed(4)}, communities=${best.cCount}</div>`
    : `<div class="muted">No valid Q computed in sweep.</div>`;

  ui.stats.innerHTML += `
    <div style="margin-top:8px;">
      <strong>Gamma sweep (Louvain):</strong><br/>
      ${lines.join("<br/>")}
      ${bestLine}
    </div>
  `;
}

function updateCommunityParameterAvailability() {
  if (!ui.louvainGammaInput) {
    return;
  }
  const hasParametricLouvain = Boolean(
    (cy && typeof cy.louvain === "function")
      || (typeof window !== "undefined" && typeof window.jLouvain === "function")
  );
  ui.louvainGammaInput.disabled = !hasParametricLouvain;
  if (!hasParametricLouvain) {
    ui.louvainGammaInput.title = "Gamma is unavailable: no Louvain implementation loaded.";
  } else {
    ui.louvainGammaInput.title = "";
  }
}

function stringToColor(input) {
  const str = String(input || "Unknown");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 68%, 56%)`;
}

function runNationalityColoring() {
  const nationalities = new Set();
  const colorMap = {};

  cy.nodes(":visible").forEach((node) => {
    const nat = node.data("nationality") || "Unknown";
    nationalities.add(nat);
    if (!colorMap[nat]) {
      colorMap[nat] = stringToColor(nat);
    }
    node.style("background-color", colorMap[nat]);
  });

  selectedNationalityMap = colorMap;

  const topN = Array.from(nationalities).sort().slice(0, 8);
  const legend = topN
    .map((nat) => `<span style="color:${colorMap[nat]};">■</span> ${nat}`)
    .join("<br/>");
  const more = nationalities.size > 8 ? `<br/>... +${nationalities.size - 8} more` : "";
  ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Nationality colors:</strong><br/>${legend}${more}</div>`;
}

function bindEvents() {
  ui.applyLayoutBtn.addEventListener("click", () => {
    const layoutName = ui.layoutSelect.value;
    if (layoutName === "fr") {
      runFruchtermanReingoldLayout({ clustered: false });
      return;
    }
    if (layoutName === "fr_clustered") {
      const detection = ensureCommunitiesForLayouts();
      selectedCommunityMap = detection.map;
      runFruchtermanReingoldLayout({ clustered: true });
      ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community-aware layout:</strong> clustered FR (${detection.method})</div>`;
      return;
    }
    if (layoutName === "community_force_blocks") {
      runCommunityForceBlocksLayout();
      return;
    }
    if (layoutName === "community_ring") {
      const detection = ensureCommunitiesForLayouts();
      selectedCommunityMap = detection.map;
      runCommunityMacroLayout("ring");
      ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community-aware layout:</strong> ring (${detection.method})</div>`;
      return;
    }
    if (layoutName === "community_grid") {
      const detection = ensureCommunitiesForLayouts();
      selectedCommunityMap = detection.map;
      runCommunityMacroLayout("grid");
      ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community-aware layout:</strong> grid (${detection.method})</div>`;
      return;
    }
    if (layoutName === "temporal_free") {
      runTemporalLayout("free");
      return;
    }
    if (layoutName === "temporal_bands") {
      const detection = ensureCommunitiesForLayouts();
      selectedCommunityMap = detection.map;
      runTemporalLayout("bands");
      ui.stats.innerHTML += `<div style="margin-top:8px;"><strong>Community-aware layout:</strong> temporal bands (${detection.method})</div>`;
      return;
    }
    if (layoutName === "dag_layers_tb") {
      runDagLayerTreeLayout("TB");
      return;
    }
    if (layoutName === "dag_layers_lr") {
      runDagLayerTreeLayout("LR");
      return;
    }
    cy.layout(makeLayout(layoutName)).run();
  });

  ui.edgeTypeSelect.addEventListener("change", () => {
    clearSelection();
    selectedCommunityMap = null;
    selectedCommunityMethod = null;
    filterByEdgeType(ui.edgeTypeSelect.value);
    applySearch(ui.searchInput.value);
    cy.fit(cy.elements(":visible"), 60);
  });

  ui.searchInput.addEventListener("input", (event) => {
    applySearch(event.target.value);
  });

  ui.edgeColorModeSelect.addEventListener("change", () => {
    edgeColorMode = ui.edgeColorModeSelect.value;
    refreshEdgeStyle();
    updateStats();
  });

  ui.edgeOpacitySlider.addEventListener("input", () => {
    edgeOpacityValue = Number(ui.edgeOpacitySlider.value);
    ui.edgeOpacityValue.textContent = edgeOpacityValue.toFixed(2);
    refreshEdgeStyle();
  });

  ui.edgeWidthSlider.addEventListener("input", () => {
    edgeWidthValue = Number(ui.edgeWidthSlider.value);
    ui.edgeWidthValue.textContent = edgeWidthValue.toFixed(2);
    refreshEdgeStyle();
  });

  ui.communitiesBtn.addEventListener("click", () => {
    runModularityColoring();
  });

  ui.nationalityBtn.addEventListener("click", () => {
    runNationalityColoring();
  });

  ui.computeNationalityBtn.addEventListener("click", () => {
    updateStats();
    renderNationalityDistributionLive(getTopKValue());
  });

  ui.highlightTopKBtn.addEventListener("click", () => {
    updateStats();
    highlightTopKNationalities(getTopKValue());
  });

  ui.clearTopKBtn.addEventListener("click", () => {
    clearTopKHighlight();
    updateStats();
  });

  ui.computeTopDegreeBtn.addEventListener("click", () => {
    updateStats();
    renderTopDegreeLive(getTopKValue(), ui.degreeModeSelect.value);
  });

  ui.highlightTopDegreeBtn.addEventListener("click", () => {
    updateStats();
    highlightTopDegree(getTopKValue(), ui.degreeModeSelect.value);
  });

  ui.clearTopDegreeBtn.addEventListener("click", () => {
    clearTopDegreeHighlight();
    updateStats();
  });

  ui.communityDefaultsBtn.addEventListener("click", () => {
    restoreCommunitySettingsDefaults();
  });

  ui.gammaSweepBtn.addEventListener("click", () => {
    runGammaSweepAndReportQ();
  });

  ui.guideModeBtn.addEventListener("click", () => {
    startGuidedTour();
  });

  ui.resetStyleBtn.addEventListener("click", () => {
    cy.style(baseStyle());
    selectedCommunityMap = null;
    selectedCommunityMethod = null;
    selectedNationalityMap = null;
    clearTopKHighlight();
    clearTopDegreeHighlight();
    clearSelection();
    edgeColorMode = "influence_type";
    edgeOpacityValue = 0.85;
    edgeWidthValue = 1.6;
    if (ui.edgeColorModeSelect) ui.edgeColorModeSelect.value = edgeColorMode;
    if (ui.edgeOpacitySlider) ui.edgeOpacitySlider.value = String(edgeOpacityValue);
    if (ui.edgeOpacityValue) ui.edgeOpacityValue.textContent = edgeOpacityValue.toFixed(2);
    if (ui.edgeWidthSlider) ui.edgeWidthSlider.value = String(edgeWidthValue);
    if (ui.edgeWidthValue) ui.edgeWidthValue.textContent = edgeWidthValue.toFixed(2);
    refreshEdgeStyle();
    updateStats();
  });

  ui.fitBtn.addEventListener("click", () => {
    cy.fit(cy.elements(":visible"), 60);
  });

  cy.on("tap", "node", (event) => {
    const node = event.target;
    const neighborNodes = node.connectedNodes(":visible").difference(node);
    const neighborEdges = node.connectedEdges(":visible");

    clearFocusClasses();
    cy.nodes(":visible").addClass("faded-node");
    cy.edges(":visible").addClass("faded-edge");
    node.removeClass("faded-node").addClass("highlighted selected-node");
    neighborNodes.removeClass("faded-node").addClass("highlighted neighbor-node");
    neighborEdges.removeClass("faded-edge").addClass("highlighted selected-edge");
    cy.fit(node.union(neighborNodes).union(neighborEdges), 90);
    renderChefDetails(node);
  });

  cy.on("tap", (event) => {
    if (event.target === cy) {
      clearSelection();
      applySearch(ui.searchInput.value);
    }
  });
}

function initializeGraph(nodes, edges) {
  const elements = toElements(nodes, edges);
  cy = cytoscape({
    container: document.getElementById("cy"),
    elements,
    style: baseStyle(),
    layout: makeLayout("cose"),
    wheelSensitivity: 0.2
  });
  if (typeof window !== "undefined") {
    window.__CHEF_CY__ = cy;
  }
  bindEvents();
  updateCommunityParameterAvailability();
  if (ui.edgeOpacityValue) {
    ui.edgeOpacityValue.textContent = edgeOpacityValue.toFixed(2);
  }
  if (ui.edgeWidthValue) {
    ui.edgeWidthValue.textContent = edgeWidthValue.toFixed(2);
  }
  refreshEdgeStyle();
  updateStats();
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (error) {
        reject(new Error(`Invalid JSON in ${file.name}: ${error.message}`));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

function startApp(nodes, edges, partitionData) {
  document.getElementById("unlockOverlay").hidden = true;
  initializeGraph(nodes, edges);
  if (partitionData) {
    indexRepresentativePartition(partitionData);
    const count = Object.keys(representativePartitionNodeMap).length;
    const numCommunities = partitionData.selection?.num_communities ?? "?";
    ui.stats.innerHTML += `<div><strong>Representative partition:</strong> loaded (${count} chefs, ${numCommunities} communities). Select it in "Community detection algorithm".</div>`;
  }
}

async function unlockWithKey(keyText) {
  const status = document.getElementById("unlockStatus");
  status.textContent = "Decrypting...";
  try {
    const data = await decryptData(keyText);
    try {
      sessionStorage.setItem(KEY_SESSION_STORAGE, keyText);
    } catch (error) {
      // storage unavailable; reload will just ask again
    }
    status.textContent = "";
    startApp(data.nodes, data.edges, data.partition);
  } catch (error) {
    status.textContent = error.message;
  }
}

function bindUnlockOverlay() {
  document.getElementById("unlockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const keyText = document.getElementById("keyInput").value;
    if (keyText.trim()) unlockWithKey(keyText.replace(/^.*#key=/, ""));
  });

  document.getElementById("loadFilesBtn").addEventListener("click", async () => {
    const status = document.getElementById("unlockStatus");
    const nodesFile = document.getElementById("nodesFileInput").files[0];
    const edgesFile = document.getElementById("edgesFileInput").files[0];
    const partitionFile = document.getElementById("partitionFileInput").files[0];
    if (!nodesFile || !edgesFile) {
      status.textContent = "Select both the nodes and edges JSON files.";
      return;
    }
    try {
      const [nodes, edges, partition] = await Promise.all([
        readJsonFile(nodesFile),
        readJsonFile(edgesFile),
        partitionFile ? readJsonFile(partitionFile) : Promise.resolve(null)
      ]);
      startApp(nodes, edges, partition);
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function init() {
  bindUnlockOverlay();
  const match = window.location.hash.match(/key=([A-Za-z0-9_-]+)/);
  if (match) {
    // Remove the key from the address bar/history once read.
    history.replaceState(null, "", window.location.pathname + window.location.search);
    unlockWithKey(match[1]);
    return;
  }
  let stored = null;
  try {
    stored = sessionStorage.getItem(KEY_SESSION_STORAGE);
  } catch (error) {
    stored = null;
  }
  if (stored) unlockWithKey(stored);
}

init();
