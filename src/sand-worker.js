import * as THREE from "three";
import { sandColor, seabedHeight } from "./utils.js";

/**
 * The near seabed is a 385 x 385 vertex mesh. Recomputing its static height,
 * colour and normal buffers on the main thread caused a 200-300 ms hitch each
 * time the camera moved into a new 34 m window. The work is deterministic and
 * independent of the simulation, so it belongs in a worker. The main thread
 * only uploads the finished attributes and moves the mesh.
 *
 * The buffers go back and forth without copies: each result is transferred
 * to the main thread, which hands the buffers it no longer draws back here
 * ("recycle") for the next window.
 */

let count = 0;
let localX = null;
let localZ = null;
let indices = null;
const recycled = [];
const color = new THREE.Color();

const buffer = (pool, length) => {
  const reuse = pool && pool.length === length ? pool : null;
  return reuse || new Float32Array(length);
};

onmessage = (event) => {
  const data = event.data;

  if (data.type === "init") {
    count = data.positions.length / 3;
    localX = new Float32Array(count);
    localZ = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      localX[i] = data.positions[i * 3];
      localZ[i] = data.positions[i * 3 + 2];
    }
    indices = data.index;
    return;
  }

  if (data.type === "recycle") {
    recycled.push(data);
    return;
  }

  if (data.type !== "recenter" || !count || !indices) return;

  const { id, centerX, centerZ } = data;
  const pool = recycled.pop() || {};
  const positions = buffer(pool.positions, count * 3);
  const colors = buffer(pool.colors, count * 3);
  const normals = buffer(pool.normals, count * 3);
  normals.fill(0);

  for (let i = 0; i < count; i++) {
    const x = localX[i] + centerX;
    const z = localZ[i] + centerZ;
    const h = seabedHeight(x, z);
    positions[i * 3] = localX[i];
    positions[i * 3 + 1] = h;
    positions[i * 3 + 2] = localZ[i];
    sandColor(x, z, h, color);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  // Vertex normals from the same triangle winding as the mesh. Accumulating
  // face normals keeps the low-frequency seabed shape continuous across the
  // recenter without a second main-thread computeVertexNormals pass.
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const ax = localX[a];
    const az = localZ[a];
    const ay = positions[a * 3 + 1];
    const ux = localX[b] - ax;
    const uy = positions[b * 3 + 1] - ay;
    const uz = localZ[b] - az;
    const vx = localX[c] - ax;
    const vy = positions[c * 3 + 1] - ay;
    const vz = localZ[c] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[a * 3] += nx;
    normals[a * 3 + 1] += ny;
    normals[a * 3 + 2] += nz;
    normals[b * 3] += nx;
    normals[b * 3 + 1] += ny;
    normals[b * 3 + 2] += nz;
    normals[c * 3] += nx;
    normals[c * 3 + 1] += ny;
    normals[c * 3 + 2] += nz;
  }

  let up = 0;
  for (let i = 0; i < count; i++) {
    up += normals[i * 3 + 1];
    const x = normals[i * 3];
    const y = normals[i * 3 + 1];
    const z = normals[i * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / length;
    normals[i * 3 + 1] = y / length;
    normals[i * 3 + 2] = z / length;
  }
  if (up < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] *= -1;
  }

  self.postMessage(
    { type: "recenter", id, centerX, centerZ, positions, colors, normals },
    [positions.buffer, colors.buffer, normals.buffer]
  );
};
