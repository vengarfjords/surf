import * as THREE from "three";
import { sandColor, seabedHeight } from "./utils.js";

/**
 * The near seabed is a 385 x 385 vertex mesh. Recomputing its static height,
 * colour and normal buffers on the main thread caused a 200-300 ms hitch each
 * time the camera moved into a new 34 m window. The work is deterministic and
 * independent of the simulation, so it belongs in a worker. The main thread
 * only uploads the finished attributes and moves the mesh.
 */

let count = 0;
let localX = null;
let localZ = null;
let indices = null;
const color = new THREE.Color();

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

  if (data.type !== "recenter" || !count || !indices) return;

  const { id, centerX, centerZ } = data;
  const heights = new Float32Array(count);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = localX[i] + centerX;
    const z = localZ[i] + centerZ;
    const h = seabedHeight(x, z);
    heights[i] = h;
    sandColor(x, z, h, color);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  // Vertex normals from the same triangle winding as the mesh. Accumulating
  // face normals keeps the low-frequency seabed shape continuous across the
  // recenter without a second main-thread computeVertexNormals pass.
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const ax = localX[a];
    const az = localZ[a];
    const bx = localX[b];
    const bz = localZ[b];
    const cx = localX[c];
    const cz = localZ[c];
    const ux = bx - ax;
    const uy = heights[b] - heights[a];
    const uz = bz - az;
    const vx = cx - ax;
    const vy = heights[c] - heights[a];
    const vz = cz - az;
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
    { type: "recenter", id, centerX, centerZ, heights, colors, normals },
    [heights.buffer, colors.buffer, normals.buffer]
  );
};
