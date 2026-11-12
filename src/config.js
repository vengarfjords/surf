/**
 * OCEAN — central tuning.
 *
 * Every number that shapes how the water, the creature, or the camera feels
 * lives here. The object is exposed at runtime as window.OCEAN.tuning, and a
 * live tuning panel (T) is generated from the `TUNE_CONTROLS` map at the
 * bottom of the file. Grab a number, interpolate it, feel it, keep it.
 */
export const TUNING = {
  world: {
    size: 3000,
    boundary: 1425,
    start: { x: -2.5, y: -5.8, z: 8.0 },
    startYaw: 0.06,
    startPitch: -0.04,
  },

  dolphin: {
    length: 3.05,
    // Tail beat / dorsoventral wave. The wave runs from the torso to the
    // flukes, and its frequency and heave rise with speed and acceleration.
    tailBeatBase: 2.1,
    tailBeatSpeed: 1.1,
    tailBeatAccel: 0.55,
    tailBeatMax: 22,
    tailThrustBeat: 1.1,
    tailSurgeBeat: 1.5,
    // tailWaveAmplitude is a global stroke scale; heave values are in metres.
    tailWaveAmplitude: 3.15,
    // Phase lag per 0.3 m segment. At cruise this puts the body-wave phase
    // speed close to the swim speed, giving a longer, dolphin-like undulation
    // instead of a short snake wave.
    tailWaveTravel: 0.48,
    tailWaveStart: 0.24,
    tailHeaveIdle: 0.012,
    tailHeaveSpeed: 0.14,
    tailHeaveAccel: 0.14,
    tailHeaveMax: 0.31,
    tailThrustHeave: 0.015,
    tailSurgeHeave: 0.03,
    tailAccelReference: 3.0,
    tailAccelSmoothing: 6.0,
    tailAccelClamp: 8.0,
    flukePitch: 0.22,
    bodyFollow: 1.35,
    // Per-joint anatomical limits, in radians. Wide enough for a free snout
    // lead, tight enough to keep the neck and torso from folding.
    headBendLimit: 0.55,
    // Base limit for the mid-body; it tapers stiffer toward the shoulders and
    // looser toward the peduncle, like a real dolphin's vertebral column.
    bodyBendLimit: 0.3,
    skin: 0x7d9297,
    belly: 0xb3bfb9,
  },

  movement: {
    // Forward propulsion and terminal velocity. These are deliberately lively:
    // the animal should leap off the line and carry deep momentum into a breach.
    cruiseSpeed: 9.5,
    boostSpeed: 21.0,
    acceleration: 8.5,
    boostAcceleration: 15.0,
    braking: 6.0,
    reverseSpeed: 1.7,
    reverseAcceleration: 1.1,
    idleGlide: 0.22,

    // Steering. Lower smoothing = more angular inertia. Mouse and A/D feed
    // the same target heading; pitch can be driven by the mouse or W/S while
    // Space/C supply an independent vertical swim force.
    maxTurnRate: 1.55,
    turnResponsiveness: 5.6,
    turnDamping: 4.4,
    maxPitchRate: 1.05,
    pitchResponsiveness: 6.4,
    // Zero means the snout holds the attitude you point it at. Set this above
    // zero if you want a slow self-level after the mouse rests.
    pitchReturn: 0,
    pitchTrimDelay: 2.4,
    mouseSensitivity: 0.003,

    // Banking / body roll: the dolphin carves with its whole body.
    banking: 1.16,
    maxBank: 1.02,
    bankResponsiveness: 4.2,
    bankIntoDrift: 0.46,

    // Hydrodynamic drift. Anisotropic body-frame drag lets the body keep its
    // momentum while the nose rotates, so fast turns slide before catching up.
    forwardDrag: 0.03,
    forwardQuadraticDrag: 0.01,
    lateralDrag: 0.55,
    verticalDrag: 0.35,
    angularDrag: 0.35,

    // Vertical swim force (neutral buoyancy underwater).
    verticalThrust: 1.8,
    ascendPitch: 0.52,
    descendPitch: -0.44,

    // Surface / seafloor behavior.
    surfaceRide: 2.4,
    waveSurf: 0.82,
    gravity: 9.81,
    floorClearance: 0.52,
    floorBounce: 0.3,
    breachImpulse: 1.6,
    boundaryPush: 1.8,

    // Airborne translation. The animal is ballistic, but the body still
    // glides: low drag, reduced gravity, a little speed-dependent lift and
    // real velocity steering from the snout.
    airGravity: 9.81,
    airLift: 0.0065,
    airSteer: 0.72,
    airForwardDrag: 0.01,
    airForwardQuadraticDrag: 0.0025,
    airLateralDrag: 0.08,
    airVerticalDrag: 0.02,
    airThrustScale: 0.1,
    airVerticalScale: 0.15,
    airTailScale: 0.35,

    // A quiet, always-present current keeps world and camera alive.
    currentX: 0.2,
    currentZ: -0.14,
    currentY: 0.025,
    currentVariance: 0.22,
    currentCoupling: 0.055,

    // Limits.
    maxPitch: 1.42,
    maxRollVisual: 1.04,
    bodyRadius: 0.52,
    noseRadius: 0.24,
    cameraShakeDecay: 3.4,
  },

  /**
   * M2 hull hydrodynamics. The physics hull is a surface of revolution
   * slightly inside the visual mesh, sampled as 196 panels. Mass is derived
   * from the displaced volume; buoyancyRatio < 1 leaves the animal a little
   * positively buoyant so it floats with a stable waterline.
   */
  hydro: {
    hullScale: 0.82,
    radialPanels: 12,
    density: 1025,
    buoyancyRatio: 1.0,
    // Lungs: near the surface the animal displaces a little extra volume;
    // that gas compresses with depth, so below ~2 m it is neutrally buoyant.
    lungFraction: 0.2,
    lungDepthScale: 1.6,
    lungSpeedFade: 0.6,
    addedMassForward: 0.10,
    addedMassLateral: 1.0,
    addedMassVertical: 1.0,
    dragNormal: 0.65,
    dragTangential: 0.003,
    airDragNormal: 0.05,
    airDragTangential: 0.004,
    slamDrag: 2.4,
    slamMinSpeed: 0.35,
    // Fin lift: pectorals and flukes are separate lifting surfaces, so a
    // banked body generates a sideways component through its rolled span.
    pectoralArea: 0.04,
    flukeArea: 0.06,
    finLiftSlope: 1.5,
    flukeLiftSlope: 1.2,
    flukeOscillation: 0.12,
    finLiftMax: 1.2,
    liftCap: 5200,
    thrustAerationLoss: 0.75,
    // Passive surface trim when the player is not pitching: the body settles
    // parallel to the local face instead of floating nose-up forever.
    surfaceTrimDepth: 1.2,
    surfaceTrimRate: 1.4,
    surfaceTrimSpeed: 4.5,
    // Water-driven attitude (hull panel torque against a muscular hold).
    waterTorque: 1.0,
    waterTorqueLimit: 2500,
    addedInertia: 1.0,
    muscleFreq: 1.6,
    muscleSteerFreq: 5.5,
    muscleRollFreq: 3.2,
    muscleDamping: 0.9,
    waterYield: 2.2,
    waterYieldPitch: 0,
    panelDebugScale: 0.00045,
  },

  camera: {
    chaseDistance: 3.35,
    chaseHeight: 1.15,
    // A small shoulder offset keeps the shot alive without making the view
    // point across the dolphin instead of along its snout.
    shoulder: 0.7,
    targetAhead: 2.95,
    lookUp: 0.1,
    // The camera orbits the snout target, not the lagging physical heading.
    lookResponsiveness: 14.0,
    positionLag: 10.0,
    rotationLag: 16.0,
    waterlineLag: 6.0,
    speedPullback: 1.15,
    speedFov: 13,
    baseFov: 62,
    rollFollow: 0.27,
    handheld: 1.0,
    shake: 0.85,
    surgeBank: 0.15,
    firstPerson: false,
    // Surf camera. While the dolphin rides at the surface (on a wave face or
    // just running the top of the water) the chase camera eases out into a
    // higher, wider follow shot that stays above the water, holds the horizon
    // and looks down the line. It eases back under when the dolphin dives.
    surfCam: true,
    surfDistance: 5.4,
    surfHeight: 1.45,
    // Lift toward the up-wave side so the face and the crest stay in frame.
    surfUpWave: 1.2,
    surfClearance: 0.9,
    surfLookAhead: 4.2,
    surfLookUp: 0.05,
    surfFov: 9,
    surfPositionLag: 5.5,
    surfLookResponsiveness: 7.0,
    surfRollFollow: 0.06,
    // Blend rates (1/s): in is unhurried, out is quicker so a dive reads.
    surfBlendIn: 1.4,
    surfBlendOut: 2.2,
  },

  /**
   * Authoritative wave field (M1).
   *
   * Two explicit directional component sums are evaluated with exactly the
   * same data on CPU and GPU:
   *   - swell: a narrow JONSWAP peak (long, coherent, organised groups)
   *   - wind sea: a broad, shorter, steeper sea offset from the swell
   *
   * `swellHeight` / `windSeaHeight` are significant wave heights Hs (m).
   * Wavelengths are peak wavelengths in metres; directions are radians,
   * measured from +X toward +Z (the direction the waves travel).
   * See src/water/spectrum.js for the spectrum construction.
   */
  water: {
    seed: 20261109,
    // Default sea state is the "groundswell" preset (see spectrum.js).
    preset: "groundswell",
    surfZoneX: 260,
    surfZoneZ: 140,
    swellHeight: 4.2,
    swellWavelength: 180,
    swellWavelengthSpread: 0.17,
    swellDirection: 0.61,
    swellDirectionSpread: 0.16,
    swellComponents: 96,
    windSeaHeight: 0.4,
    windSeaWavelength: 9.5,
    windSeaWavelengthSpread: 0.42,
    windSeaDirection: 1.02,
    windSeaDirectionSpread: 0.62,
    windSeaComponents: 32,
    // Gerstner horizontal displacement scale. The generator computes a safe
    // base value from the total steepness; this is an artistic multiplier.
    chop: 0.72,
    timeScale: 1.0,
    // Rendering / foam.
    foamThreshold: 0.56,
    foamAmount: 0.9,
    detailStrength: 0.55,
    // M3 depth response. The wave spectrum is evaluated with finite-depth
    // dispersion and Green's-law shoaling using the baked bathymetry; the
    // breaker is a saturated, aerated crest (a heightfield cannot overhang).
    depthResponse: true,
    shoalReference: 12,
    shoalStrength: 0.25,
    breakRatio: 0.85,
    breakSoftness: 0.12,
    breakerJet: 0.65,
    breakerLip: 0.12,
    aerationAmount: 0.85,
    foamPersistence: 0.6,
    // Local nonlinear shallow-water solver over the surf bank. The domain is
    // fixed around the bank; the analytic spectral field forces the open
    // boundaries. 160² cells at 30 Hz is ~25k updates per step.
    solverEnabled: false,
    solverExtent: 192,
    solverCells: 128,
    solverRate: 20,
    solverSpongeCells: 10,
    solverBreakSlope: 0.5,
    solverFoamDecay: 0.22,
    solverFoamSource: 0.55,
    // Advected foam/aeration state for the analytic surf bank. This is shared
    // by the surface shader and the hull physics.
    foamFieldEnabled: true,
    foamFieldExtent: 320,
    foamFieldCells: 128,
    foamFieldRate: 15,
    foamFieldDecay: 0.18,
    foamFieldSource: 0.7,
    // Ambient breaker mist above the surf line. Reuses the particle budget;
    // the rate is spawns per second near the bank.
    surfSpray: true,
    surfSprayRate: 30,
    // Subsurface bubble plume under the break line, emitted only while the
    // camera is underwater.
    surfBubbles: true,
    surfBubblesRate: 20,
    // Radial clipmap dimensions (camera-following, exponential in radius).
    surfaceRadius: 7000,
    surfaceRings: 220,
    surfaceSegments: 256,
    meshExponent: 3.0,
  },

  waves: {
    // Small local GPU heightfield used only for contact wakes and the
    // dolphin's parting of the surface. The large-scale sea is `water`.
    simResolution: 192,
    simExtent: 92,
    simRecenters: 29,
    simWaveSpeed: 0.118,
    simDamping: 0.986,
    displacementScale: 0.92,
    splashThreshold: 1.4,
  },

  debug: {
    probe: false,
    // The parity probe is a synchronous 1x1 readback. It is a diagnostic, not
    // a frame-path feature, so it is off by default; toggle it in the T panel.
    gpuProbe: false,
    crestOverlay: false,
    slopeOverlay: false,
    foamOverlay: false,
    forceVectors: false,
    readout: true,
    postProcessing: true,
  },

  sand: {
    // A denser local heightfield: 384² over 120 m gives ~31 cm cells, enough
    // to resolve a nose trench, a fluke slap, and a low-glide pressure trough.
    mapResolution: 384,
    mapExtent: 120,
    recenterDistance: 34,
    plowRadius: 1.52,
    // Deformable layer working range. The old surface clamps only allowed
    // ~2.35 m of cut; this gives deep shoveling and real cratering.
    maxCutDepth: 3.6,
    maxPileHeight: 2.0,
    ejectaScaleMax: 8.0,
    maxContactDepth: 1.4,
    glideRadius: 3.4,
    glideDepth: 0.06,
    glideInterval: 0.07,
    trailSpacing: 0.45,
    // tan(30°) — material above this slope avalanches downslope.
    repose: 0.58,
    relaxation: 0.18,
    sedimentLift: 0.82,
    particleBudget: 1200,
    exposureDecay: 0.06,
    nearMeshExtent: 120,
    nearMeshSegments: 384,
    // Simulation rate. The renderer smooths the height texture toward the
    // simulated surface every frame, so deformation never steps at this rate.
    textureUploadHz: 30,
    visualResponse: 18,
    interactionStrength: 1.0,
  },

  visuals: {
    fogShallow: 0.51,
    fogDeep: 0.67,
    underwaterDensity: 0.0235,
    aboveDensity: 0.0012,
    renderScale: 0.6,
    // Optional governor: reduce composer resolution after sustained slow
    // frames, never below this scale. It only steps down, so it cannot hunt.
    dynamicQuality: true,
    dynamicQualityMinScale: 0.45,
    // Absolute post/scene render budget. Keeping the composer near half a
    // megapixel makes frame cost predictable on larger displays as well.
    maxPostPixels: 600000,
    maxPixelRatio: 1.15,
    // The reef is split into spatial chunks so fogged/off-screen regions are
    // never submitted. Both distances sit beyond the point where underwater
    // fog makes the geometry unreadable.
    reefChunkSize: 90,
    reefCullDistance: 120,
    grassChunkSize: 80,
    grassCullDistance: 100,
    bloomStrength: 0.16,
    bloomRadius: 0.6,
    bloomThreshold: 1.45,
    exposure: 1.34,
    grain: 0.095,
    aberration: 0.0042,
    vignette: 0.58,
    cameraTint: 0.15,
    motionBlur: 0.22,
    causticStrength: 1.25,
    // Depth-aware post lighting. Scatter adds the deep-water veil, shafts
    // are the screen-space god rays, caustics tie surfaces into one light
    // field, and haze/mist warm the air above the surface.
    volumetricScatter: 0.85,
    shaftStrength: 1.25,
    shaftSteps: 10,
    volumetricCaustics: 0.72,
    surfaceHaze: 0.42,
    surfaceMist: 0.26,
  },

  fish: {
    schools: 12,
    perSchool: 64,
    startleRadius: 13.5,
  },

  audio: {
    master: 0.24,
    ocean: 0.4,
    clicks: 0.6,
    underwaterCutoff: 700,
    surf: 1,
  },
};

export const PALETTE = {
  // Clear neritic blue with a green undertow in the shallows. The references
  // are considerably bluer than the old olive grade; the sand and seagrass
  // stay earthy so the reef still reads as a real shelf.
  fogShallow: 0x2a7096,
  fogDeep: 0x062941,
  waterTop: 0x6fc4df,
  waterDeep: 0x0a3f60,
  skyZenith: 0x6f9dba,
  skyHorizon: 0xe8c69b,
  sandLight: 0x9b8a64,
  sandShade: 0x41402f,
  sandWet: 0x5b5540,
  seagrass: 0x2a5637,
  seagrassLight: 0x7b8a57,
  skinTint: 0x879b9f,
  sunColor: 0xffdfae,
};

export const SUN_DIRECTION = { x: -0.46, y: 0.7, z: 0.55 };

/**
 * Live tuning controls. `path` points into TUNING; `min`/`max` are the useful
 * emotional range, not physical limits. Add a row and it appears in the panel.
 */
export const TUNE_CONTROLS = [
  { path: "movement.cruiseSpeed", label: "cruise speed", min: 2, max: 14, step: 0.1 },
  { path: "movement.boostSpeed", label: "surge speed", min: 8, max: 24, step: 0.1 },
  { path: "movement.acceleration", label: "acceleration", min: 1, max: 12, step: 0.1 },
  { path: "movement.turnResponsiveness", label: "turn response", min: 0.6, max: 14, step: 0.1 },
  { path: "movement.mouseSensitivity", label: "mouse look", min: 0.0008, max: 0.006, step: 0.00005 },
  { path: "movement.pitchResponsiveness", label: "pitch response", min: 0.6, max: 14, step: 0.1 },
  { path: "movement.pitchReturn", label: "pitch self-level", min: 0, max: 1.2, step: 0.01 },
  { path: "movement.lateralDrag", label: "drift / lateral drag", min: 0.05, max: 3, step: 0.01 },
  { path: "movement.banking", label: "banking intensity", min: 0, max: 2.4, step: 0.01 },
  { path: "movement.bankIntoDrift", label: "drift bank", min: 0, max: 1.5, step: 0.01 },
  { path: "movement.verticalThrust", label: "rise / dive force", min: 0.2, max: 4, step: 0.05 },
  { path: "movement.airSteer", label: "air control", min: 0, max: 4, step: 0.01 },
  { path: "movement.airLift", label: "air lift", min: 0, max: 0.05, step: 0.001 },
  { path: "movement.airGravity", label: "air gravity", min: 0, max: 14, step: 0.05 },
  { path: "movement.breachImpulse", label: "breach kick", min: 0, max: 6, step: 0.05 },
  { path: "dolphin.tailBeatSpeed", label: "tail beat", min: 0.15, max: 2.6, step: 0.01 },
  { path: "dolphin.tailBeatAccel", label: "accel beat", min: 0, max: 1.8, step: 0.01 },
  { path: "dolphin.tailWaveAmplitude", label: "tail stroke", min: 0.4, max: 5, step: 0.05 },
  { path: "dolphin.tailHeaveSpeed", label: "tail heave", min: 0, max: 0.4, step: 0.005 },
  { path: "dolphin.tailHeaveAccel", label: "accel heave", min: 0, max: 0.5, step: 0.005 },
  { path: "dolphin.tailWaveTravel", label: "wave travel", min: 0.15, max: 1.2, step: 0.01 },
  { path: "dolphin.tailWaveStart", label: "wave start", min: 0, max: 0.7, step: 0.01 },
  { path: "dolphin.flukePitch", label: "fluke pitch", min: 0, max: 0.4, step: 0.01 },
  { path: "dolphin.bodyFollow", label: "segment follow", min: 0.25, max: 2.5, step: 0.01 },
  { path: "dolphin.headBendLimit", label: "neck bend limit", min: 0.1, max: 1.1, step: 0.01 },
  { path: "dolphin.bodyBendLimit", label: "spine bend limit", min: 0.05, max: 0.9, step: 0.01 },
  { path: "water.preset", label: "sea state", type: "preset", options: ["calm", "moderate", "surf", "groundswell"] },
  { path: "water.swellHeight", label: "swell Hs (m)", min: 0.2, max: 4, step: 0.05 },
  { path: "water.swellWavelength", label: "swell λ (m)", min: 25, max: 110, step: 1 },
  { path: "water.swellDirection", label: "swell direction", min: 0, max: 6.28, step: 0.01 },
  { path: "water.swellDirectionSpread", label: "swell spread", min: 0.02, max: 0.9, step: 0.01 },
  { path: "water.swellWavelengthSpread", label: "swell bandwidth", min: 0.04, max: 0.5, step: 0.01 },
  { path: "water.windSeaHeight", label: "wind sea Hs", min: 0, max: 1.6, step: 0.02 },
  { path: "water.windSeaWavelength", label: "wind sea λ", min: 4, max: 25, step: 0.5 },
  { path: "water.windSeaDirection", label: "wind direction", min: 0, max: 6.28, step: 0.01 },
  { path: "water.windSeaDirectionSpread", label: "wind spread", min: 0.05, max: 1.2, step: 0.01 },
  { path: "water.chop", label: "crest sharpness", min: 0, max: 1.4, step: 0.01 },
  { path: "water.timeScale", label: "wave time scale", min: 0, max: 2, step: 0.01 },
  { path: "water.foamAmount", label: "whitecap amount", min: 0, max: 1.6, step: 0.01 },
  { path: "water.foamThreshold", label: "whitecap threshold", min: 0.15, max: 1, step: 0.01 },
  { path: "water.depthResponse", label: "depth response", type: "toggle" },
  { path: "water.shoalReference", label: "shoal reference depth", min: 4, max: 25, step: 0.5 },
  { path: "water.shoalStrength", label: "shoaling strength", min: 0, max: 0.5, step: 0.01 },
  { path: "water.breakRatio", label: "break H/h", min: 0.5, max: 1.2, step: 0.01 },
  { path: "water.breakSoftness", label: "break softness", min: 0.02, max: 0.3, step: 0.01 },
  { path: "water.breakerLip", label: "breaker lip", min: 0, max: 0.4, step: 0.01 },
  { path: "water.breakerJet", label: "breaker jet", min: 0, max: 2, step: 0.05 },
  { path: "water.aerationAmount", label: "aeration", min: 0, max: 1, step: 0.01 },
  { path: "water.foamPersistence", label: "foam persistence", min: 0, max: 1, step: 0.01 },
  { path: "water.solverEnabled", label: "surf-zone solver", type: "toggle" },
  { path: "water.solverBreakSlope", label: "solver break slope", min: 0.3, max: 1.5, step: 0.01 },
  { path: "water.solverFoamSource", label: "solver foam source", min: 0, max: 1, step: 0.01 },
  { path: "water.foamFieldEnabled", label: "advected foam", type: "toggle" },
  { path: "water.foamFieldSource", label: "foam source", min: 0, max: 1.5, step: 0.01 },
  { path: "water.foamFieldDecay", label: "foam decay", min: 0.02, max: 1, step: 0.01 },
  { path: "water.surfSpray", label: "surf spray", type: "toggle" },
  { path: "water.surfSprayRate", label: "surf spray rate", min: 0, max: 60, step: 1 },
  { path: "water.surfBubbles", label: "surf plume", type: "toggle" },
  { path: "water.surfBubblesRate", label: "surf plume rate", min: 0, max: 60, step: 1 },
  { path: "hydro.buoyancyRatio", label: "buoyancy ratio", min: 0.9, max: 1.05, step: 0.001 },
  { path: "hydro.lungFraction", label: "lung buoyancy", min: 0, max: 0.4, step: 0.005 },
  { path: "hydro.lungDepthScale", label: "lung depth scale", min: 0.3, max: 4, step: 0.05 },
  { path: "hydro.lungSpeedFade", label: "lung speed fade", min: 0, max: 1, step: 0.01 },
  { path: "hydro.addedMassLateral", label: "added mass · side", min: 0, max: 2, step: 0.01 },
  { path: "hydro.addedMassVertical", label: "added mass · vertical", min: 0, max: 2, step: 0.01 },
  { path: "hydro.dragNormal", label: "panel normal drag", min: 0.1, max: 2.5, step: 0.01 },
  { path: "hydro.dragTangential", label: "skin drag", min: 0.0005, max: 0.02, step: 0.0005 },
  { path: "hydro.finLiftSlope", label: "fin lift", min: 0, max: 6, step: 0.05 },
  { path: "hydro.slamDrag", label: "slam drag", min: 0, max: 8, step: 0.1 },
  { path: "hydro.surfaceTrimRate", label: "surface trim", min: 0, max: 4, step: 0.05 },
  { path: "debug.probe", label: "water probe", type: "toggle" },
  { path: "debug.gpuProbe", label: "GPU parity probe", type: "toggle" },
  { path: "debug.crestOverlay", label: "crest lines", type: "toggle" },
  { path: "debug.slopeOverlay", label: "slope overlay", type: "toggle" },
  { path: "debug.foamOverlay", label: "foam / aeration", type: "toggle" },
  { path: "debug.forceVectors", label: "force vectors (M2)", type: "toggle" },
  { path: "debug.readout", label: "water readout", type: "toggle" },
  { path: "debug.postProcessing", label: "post-processing", type: "toggle" },
  { path: "sand.interactionStrength", label: "sand disturbance", min: 0.1, max: 2.4, step: 0.01 },
  { path: "sand.maxCutDepth", label: "sand cut depth", min: 1, max: 7, step: 0.1 },
  { path: "sand.maxContactDepth", label: "contact cut depth", min: 0.2, max: 2.5, step: 0.05 },
  { path: "sand.glideDepth", label: "glide scoop", min: 0.01, max: 0.24, step: 0.005 },
  { path: "visuals.volumetricScatter", label: "water scatter", min: 0, max: 2, step: 0.01 },
  { path: "visuals.shaftStrength", label: "god rays", min: 0, max: 1.6, step: 0.01 },
  { path: "visuals.volumetricCaustics", label: "caustic light", min: 0, max: 1.8, step: 0.01 },
  { path: "visuals.surfaceHaze", label: "surface haze", min: 0, max: 1.5, step: 0.01 },
  { path: "visuals.surfaceMist", label: "sea mist", min: 0, max: 1.5, step: 0.01 },
  { path: "audio.surf", label: "surf roar", min: 0, max: 1.5, step: 0.01 },
  { path: "visuals.dynamicQuality", label: "dynamic quality", type: "toggle" },
  { path: "visuals.dynamicQualityMinScale", label: "min render scale", min: 0.4, max: 0.8, step: 0.01 },
  { path: "hydro.waterTorque", label: "water torque", min: 0, max: 2, step: 0.05 },
  { path: "hydro.muscleFreq", label: "body yield stiffness", min: 0.3, max: 6, step: 0.1 },
  { path: "hydro.waterYield", label: "go with the water", min: 0, max: 6, step: 0.1 },
  { path: "camera.chaseDistance", label: "camera distance", min: 2.5, max: 12, step: 0.1 },
  { path: "camera.shoulder", label: "camera shoulder", min: 0, max: 2.2, step: 0.01 },
  { path: "camera.lookResponsiveness", label: "look response", min: 2, max: 28, step: 0.1 },
  { path: "camera.surfCam", label: "surf camera", type: "toggle" },
  { path: "camera.surfDistance", label: "surf cam distance", min: 3, max: 16, step: 0.1 },
  { path: "camera.surfHeight", label: "surf cam height", min: 0.5, max: 6, step: 0.1 },
];
