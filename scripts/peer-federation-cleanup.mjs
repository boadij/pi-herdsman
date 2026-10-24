import { join, resolve } from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOCKER_ID = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

export function isMissingDockerResource(kind, id, stderr) {
  return (
    (kind === "container" && stderr.includes(`No such object: ${id}`)) ||
    (kind === "network" && stderr.includes(`network ${id} not found`)) ||
    (kind === "volume" && stderr.includes(`get ${id}: no such volume`)) ||
    (kind === "image" && stderr.includes(`No such image: ${id}`))
  );
}

export function cleanupSmokeFixture(resources, manifestPath, options) {
  const {
    canonicalize,
    fixtureBase,
    inspectResource,
    removeResource,
    removeRoot,
  } = options;
  if (
    typeof resources.runId !== "string" ||
    !new RegExp(`^peer474-${UUID}$`, "u").test(resources.runId)
  )
    throw new Error("refusing invalid smoke fixture run ID");

  const expectedRoot = resolve(canonicalize(fixtureBase), resources.runId);
  const root = canonicalize(resources.root);
  if (root !== expectedRoot)
    throw new Error(
      "refusing cleanup outside the canonical smoke fixture root",
    );
  if (canonicalize(manifestPath) !== join(expectedRoot, "resources.json"))
    throw new Error(
      "refusing cleanup from a manifest outside its smoke fixture",
    );

  const expectedVolumes = new Set(
    ["a", "b"].flatMap((side) =>
      ["home", "ssh"].map((kind) => `ph-${side}-${kind}-${resources.runId}`),
    ),
  );
  if (
    !Array.isArray(resources.containers) ||
    resources.containers.some(
      (id) => typeof id !== "string" || !DOCKER_ID.test(id),
    ) ||
    new Set(resources.containers).size !== resources.containers.length ||
    !Array.isArray(resources.volumes) ||
    resources.volumes.some(
      (name) => typeof name !== "string" || !expectedVolumes.has(name),
    ) ||
    new Set(resources.volumes).size !== resources.volumes.length ||
    (resources.network !== null &&
      (typeof resources.network !== "string" ||
        !DOCKER_ID.test(resources.network))) ||
    (resources.imageTag !== null &&
      resources.imageTag !== `${resources.runId}:fixture`) ||
    (resources.image !== null &&
      (typeof resources.image !== "string" ||
        !IMAGE_ID.test(resources.image))) ||
    (resources.image !== null && resources.imageTag === null)
  )
    throw new Error("refusing invalid smoke fixture Docker resources");

  const resourcesToRemove = [
    ...resources.containers.map((id) => ["container", id]),
    ...resources.volumes.map((name) => ["volume", name]),
    ...(resources.network ? [["network", resources.network]] : []),
    ...(resources.imageTag ? [["image", resources.imageTag]] : []),
  ];
  const containerSides = new Set();
  const verifiedResources = [];
  for (const [kind, id] of resourcesToRemove) {
    const inspected = inspectResource(kind, id);
    if (!inspected) continue;
    if (inspected.labels?.["pi-herdsman.run"] !== resources.runId)
      throw new Error(`refusing unowned smoke fixture ${kind}`);
    if (kind === "container") {
      const side = inspected.labels["pi-herdsman.side"];
      if (!["a", "b"].includes(side) || containerSides.has(side))
        throw new Error("refusing invalid smoke fixture container ownership");
      containerSides.add(side);
    }
    if (kind === "image" && resources.image && inspected.id !== resources.image)
      throw new Error("refusing replaced smoke fixture image");
    verifiedResources.push([kind, id]);
  }

  for (const [kind, id] of verifiedResources) removeResource(kind, id);
  const leftovers = [];
  for (const [kind, id] of verifiedResources)
    if (inspectResource(kind, id)) leftovers.push(kind);
  if (leftovers.length)
    throw new Error(`fixture cleanup left exact ${leftovers.join(", ")}`);
  removeRoot(root);
  return root;
}
