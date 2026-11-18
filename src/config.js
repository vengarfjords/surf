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
    // Rate (1/s) at which the stroke winds up or dies away when W or Shift
    // is pressed or let go, and when the tail leaves or meets the water.
    tailEase: 9,
    tailAccelClamp: 8.0,
    flukePitch: 0.22,
    bodyFollow: 1.35,
    // Per-joint anatomical limits, in radians. Wide enough for a free snout
    // lead, tight enough to keep the neck and torso from folding.
    headBendLimit: 0.55,
    // Base limit for the mid-body; it tapers stiffer toward the shoulders and
    // looser toward the peduncle, like a real dolphin's vertebral column.
    bodyBendLimit: 0.3,
    skin: 0x3d484e,
    belly: 0xb3bfb9,
  },

  movement: {
    // Forward propulsion and terminal velocity. These are deliberately lively:
    // the animal should leap off the line and carry deep momentum into a breach.
    cruiseSpeed: 9.5,
    boostSpeed: 21.0,
    acceleration: 8.5,
    boostAcceleration: 15.0,
    thrustTaper: 0.1,
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
    // Sand yields under the body: the speed into it is taken out at this
    // rate (1/s), faster the deeper the body is pressed in, and nothing
    // springs back (it used to stop the body dead in one frame and throw it
    // back up at a third of the speed, so a dive into the sand dribbled
    // along the bottom like a ball).
    floorYield: 20,
    breachImpulse: 1.6,
    // Shift held as the body breaks the surface: one last fluke stroke of
    // this much speed (m/s, at surge speed; scaled by exit speed) along the
    // path the body is already on, spread over `hydro.surfaceLeapStroke`
    // (about 6 g) instead of the small vertical kick above.
    breachBoost: 7,
    // Shift held in the air: the body tucks into a streamlined dive. An
    // extra downward pull (m/s^2, on top of gravity) and air drag cut to
    // this fraction. Shift held through a breach arms the dive only after
    // the top of the arc. In the water the dive's low drag is
    // `hydro.diveDragCut`; it lasts until Shift is let go.
    airDiveAccel: 8,
    airDiveDrag: 0.3,
    // A dive heading for the seabed pulls out on its own: within ~1.6 s of
    // reaching `diveFloorClear` metres above the sand, the body opens up
    // and the nose comes up toward `diveFloorPitch` at up to
    // `diveFloorRate` rad/s.
    diveFloorClear: 2.5,
    diveFloorPitch: 0.25,
    diveFloorRate: 2.5,
    boundaryPush: 1.8,

    // Airborne translation. Full gravity and a ballistic arc, shaped by the
    // air flowing over the body. Nose-first air drag on a 200 kg
    // streamlined body is tiny (about 0.5 rho Cd A / m = 4e-5 per metre);
    // the old 0.0025 braked a leap off a 70 m/s wave at 1.7 g, so the wave
    // outran its own surfer in the air.
    //
    // Steering in the air is lift: with the nose aimed off the flight path
    // (mouse, arrow keys, A/D), the body and flippers push the path toward
    // the nose, `airLiftCoef` x speed^2 x sin(angle) m/s^2, stalling past
    // `airStall` rad and capped at `airLiftMax` (0.6 g, so a held nose-up
    // stretches an arc but cannot glide level), and every bit of it costs
    // `airInducedDrag` of itself in speed. Nose along the path: no lift, a
    // pure arc. `airAimMax` is how far off the path the nose can be held.
    airGravity: 9.81,
    airLiftCoef: 0.035,
    airLiftMax: 6,
    airStall: 0.5,
    airInducedDrag: 0.2,
    airAimMax: 0.6,
    // How far off the flight path A/D can swing the nose sideways (rad).
    airYawMax: 0.6,
    // How fast the push follows W / Shift (1/s): about 0.07 s to wind up.
    thrustEase: 14,
    // Time (s) over which the water takes the speed a re-entry costs.
    entryLossTime: 0.12,
    // Weathervane: rate (1/s) at which the nose relaxes back onto the
    // flight path once the player stops aiming it.
    airAimReturn: 1.5,
    // Below this speed (m/s) the nose is not tied to the flight path.
    airPathSpeed: 4,
    // How fast the automatic pitch (ride trim, surface lock) may turn the
    // nose just after a flight ends (rad/s).
    landingPitchRate: 3,
    // For `landingTrimTime` s after a flight ends, the ride trim pulls the
    // nose no higher than `landingClimb` rad above level (plus the slope
    // needed to follow a rising surface): a re-entry levels out and rises
    // gently instead of whipping straight back up.
    landingClimb: 0.25,
    landingTrimTime: 2.4,
    // Fastest the nose is turned up or down by anything other than the
    // player's own input (leap, flight path, ride trim, surface lock), rad/s.
    autoPitchRate: 5,
    airForwardDrag: 0.004,
    airForwardQuadraticDrag: 0.0004,
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
    axialDragScale: 0.15,
    // Planing (hull.js): at the surface, above `planeSpeed` m/s through the
    // water, axial and skin drag fall off by up to `planeDragCut` over the
    // next `planeSpeedRange` m/s.
    planeSpeed: 18,
    // Planing onset while gliding on a wave with Space held (board-like).
    planeSpeedGlide: 6,
    planeSpeedRange: 14,
    planeDragCut: 0.85,
    // Shift dive (movement.airDiveAccel): while it lasts the body is tucked
    // and streamlined. Axial and skin drag are cut by `diveDragCut`, the
    // tucked flippers give `1 - diveFinCut` of their lift, the entry slam is
    // cut by `diveSlamCut`, and the speed lost on entering the water by
    // `diveEntryKeep`, so the velocity carries straight through the surface.
    // Crossflow drag is unchanged: the body still tracks along its axis and
    // the mouse still steers it. The tail does not stroke.
    diveDragCut: 0.6,
    diveFinCut: 0.8,
    diveSlamCut: 0.7,
    diveEntryKeep: 0.85,
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
    // Keel (hull.js): the slender body, dorsal fin and tail stock as a
    // vertical foil. Side force = 1/2 rho x keelArea x keelLiftSlope x
    // sideslip x speed^2, at right angles to the path, up to a sideslip of
    // `keelStall` rad and twice `liftCap`. At cruise it pulls a small slip
    // out in about a third of a second.
    keelArea: 0.2,
    keelLiftSlope: 3.0,
    keelStall: 0.35,
    thrustAerationLoss: 0.75,
    // Passive surface trim when the player is not pitching: the body settles
    // parallel to the local face instead of floating nose-up forever.
    surfaceTrimDepth: 1.2,
    surfaceTrimRate: 1.4,
    surfaceTrimSpeed: 4.5,
    // Surface lock (dolphin.js _surfaceLockUpdate): hold Space to rise to
    // the surface and travel or surf along it; release for free 3D swimming.
    surfaceLock: 1,
    surfaceLockDepth: 0.35,
    surfaceLockEnter: 1.0,
    surfaceLockExit: 3.5,
    surfaceLockGain: 8,
    surfaceLockRamp: 5,
    surfaceLockPitchRate: 12,
    // Landing back into the ride from the air: a flukes-only touch lands the
    // body from up to `surfaceLockReach` m above the surface, then for up to
    // `surfaceLockSettleTime` s it settles in: drawn down at most
    // `surfaceLockSettlePull` m/s^2 on top of gravity while above the lock
    // depth, and braked at most `surfaceLockSettleBrake` m/s^2 below it.
    surfaceLockReach: 2.5,
    surfaceLockSettleTime: 2,
    surfaceLockSettlePull: 15,
    surfaceLockSettleBrake: 60,
    // The brake scales with the landing speed: it stops the body within
    // about `surfaceLockSettleDip` m, never gentler than `...BrakeMin`.
    surfaceLockSettleBrakeMin: 25,
    surfaceLockSettleDip: 0.8,
    // Letting go of Space while on the surface leaps: a tail drive of
    // `surfaceLeapForward` m/s (+ `surfaceLeapDriveShare` x speed through the
    // water, up to +8) along the heading and `surfaceLeap` m/s (+ share, up
    // to +3) off the surface, on top of the wave's momentum. On open water
    // (no wave to borrow from) the forward drive is the smaller
    // `surfaceLeapForwardCalm` (+ half the share, up to +4), so a flat-water
    // leap leaves at about 20-25 degrees, like a real one. The drive is one
    // fluke stroke of `surfaceLeapStroke` s, not an instant kick.
    surfaceLeap: 6,
    surfaceLeapForward: 10,
    surfaceLeapForwardCalm: 3,
    surfaceLeapSpeedShare: 0.1,
    surfaceLeapDriveShare: 0.3,
    surfaceLeapStroke: 0.12,
    // On a wave (surface slope above `surfGlideSlope`, or water under the
    // body moving faster than `surfGlideFlow` m/s) the tail stops while
    // coasting (no W) and the dolphin glides. Heading down a face (the
    // surface falling `glideDownSlope` m per m along the heading) it stops
    // even with W or Shift held: gravity on the face does the work. Either
    // way only on the surface: with Space held, or within
    // `glideSurfaceDepth` m of it. The tail eases in and out of it at
    // `glideRate` /s. With Space held on open water, W porpoises, leaping at
    // `porpoiseLift` x its speed through the water (m/s up) once above
    // `porpoiseSpeed` m/s.
    surfGlideSlope: 0.2,
    surfGlideFlow: 8,
    glideDownSlope: 0.12,
    glideSurfaceDepth: 2,
    glideRate: 5,
    porpoise: 1,
    porpoiseSpeed: 4.5,
    porpoiseLift: 0.38,
    porpoiseLiftMax: 5.5,
    // Skiing on the surface: heading response (1/s), A/D turn rate (rad/s),
    // edge grip that swings speed through the water into the heading (1/s),
    // and the share of the turned speed a carve costs.
    surfaceTurnResponse: 11,
    surfaceTurnRate: 2.8,
    surfaceCarveGrip: 5,
    surfaceCarveLoss: 0.06,
    // Ride trim (dolphin.js _rideTrim): stay in the face at speed.
    rideTrim: 1,
    rideTrimDepth: 2.2,
    rideTrimSpeed: 7,
    rideDepth: 0.5,
    rideDepthGain: 1.5,
    rideDamping: 2.0,
    rideRelease: 0.4,
    rideOffsetReturn: 1.1,
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
    // Fastest the underwater waterline bands move the lens, m/s on top of
    // the surface's own rise (camera.js).
    bandSpeed: 6,
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
    // Default sea state is the "storm" preset (see spectrum.js): a severe
    // storm over the shelf, Hs about 13.7 m, the biggest waves around 30 m.
    // The preset is applied on start (WaveField), so its values win over the
    // ones below; "mega" brings back the 500 m wave train.
    preset: "storm",
    // Mega wave train (field.js megaAt). Crests `megaHeight` tall (each crest
    // 0..+megaVariation taller), `megaWavelength` apart, travelling along
    // the swell direction at sqrt(g (megaDepthRef + H)), the solitary-wave
    // speed. Each crest is a sech^2 hump: `megaFront` metres wide ahead of
    // the crest (the steep face), `megaBack` behind it (the long back). The
    // troughs sit near still-water level, so the shelf never drains.
    megaWave: false,
    megaHeight: 520,
    megaVariation: 0.2,
    megaWavelength: 3000,
    megaFront: 200,
    megaBack: 500,
    megaDepthRef: 15,
    megaLateral: 0.12,
    // Centre of the big-wave reef (mirrors REEF_X/Z in utils.seabedHeight).
    surfZoneX: 700,
    surfZoneZ: -350,
    swellHeight: 13,
    swellWavelength: 300,
    swellWavelengthSpread: 0.26,
    swellGamma: 3.3,
    swellDirection: 0.61,
    swellDirectionSpread: 0.3,
    swellComponents: 96,
    windSeaHeight: 4.2,
    windSeaWavelength: 70,
    windSeaWavelengthSpread: 0.6,
    windSeaDirection: 0.78,
    windSeaDirectionSpread: 0.5,
    windGamma: 2.0,
    windSeaComponents: 32,
    // Gerstner horizontal displacement scale. The generator computes a safe
    // base value from the total steepness; this is an artistic multiplier.
    chop: 0.85,
    timeScale: 1.0,
    // Rendering / foam.
    foamThreshold: 0.56,
    foamAmount: 1.25,
    detailStrength: 0.9,
    // M3 depth response. The wave spectrum is evaluated with finite-depth
    // dispersion and Green's-law shoaling using the baked bathymetry; the
    // breaker is a saturated, aerated crest (a heightfield cannot overhang).
    depthResponse: true,
    shoalReference: 60,
    shoalStrength: 0.25,
    // Refraction focusing over the reef canyon: peak amplitude gain on the
    // reef centre line, its cross-swell half-width (m) and how far up-swell
    // (m) the focusing builds. Sets of 15-30 m stand up on the reef.
    reefFocus: 1.2,
    reefFocusCross: 95,
    reefFocusReach: 450,
    breakRatio: 0.45,
    // Broken water keeps at least this significant height (m), or 0.55 of
    // the offshore sea if that is less.
    breakFloor: 2.4,
    breakSoftness: 0.12,
    breakerJet: 0.65,
    breakerLip: 0.12,
    faceSkew: 0.9,
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
    underwaterDensity: 0.03,
    // Rain and spray haze over a storm sea: about a fifth of the light
    // gets through from a kilometre away.
    aboveDensity: 0.0014,
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
    bloomStrength: 0.22,
    bloomRadius: 0.7,
    bloomThreshold: 1.1,
    exposure: 1.34,
    grain: 0.028,
    aberration: 0.0012,
    vignette: 0.24,
    // Edge anti-aliasing in the film pass (no staircase silhouettes).
    edgeSmoothing: true,
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
    // How sharp the moving net of light is just under the surface (0 = even
    // light, 1 = hard sun). It blurs away with depth and is gone by 20 m.
    causticNet: 0.45,
    surfaceHaze: 0.42,
    surfaceMist: 0.26,
    // Look of the open sea (visual only, no effect on the wave physics).
    // whitecaps scales wind whitecap coverage, foamStreaks the wind-drawn
    // foam lines and mega-face foam scars, horizonFog how fast the far sea
    // dissolves into the horizon mist, seaMist the low mist layer.
    whitecaps: 1.7,
    foamStreaks: 1.25,
    horizonFog: 2.4,
    seaMist: 2.4,
    spindrift: 1.0,
    // Graded against the reference photographs. seaMilk: how much of the
    // deep-water colour is replaced by the pale turquoise-green of aerated
    // storm water (0 = clear dark water). seaGlow scales the light the
    // water itself scatters back, foamWhite how much brighter than the
    // horizon sky the foam is, sunGlitter the silver path and sparkle
    // under the hidden sun, skyTexture the contrast of the cloud deck (read
    // once at start).
    seaMilk: 0.88,
    seaGlow: 1.8,
    // How much a trough's low reflection shows the next wave's darker face
    // instead of the sky (0 = the sky everywhere, the flat look).
    troughShade: 0.75,
    foamWhite: 2.6,
    sunGlitter: 1.6,
    skyTexture: 0.55,
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
  // A storm over the shelf, graded against photographs: a luminous, milky
  // turquoise-green sea (the water is full of air and stirred sediment)
  // under a flat, pale grey overcast that rain haze melts into the sea
  // with no horizon line; a soft bright patch and a silver glitter under
  // the hidden sun; and, below, clear blue-teal water that falls off to a
  // dark blue with depth, over sunlit yellow-green seagrass and pale sand.
  fogShallow: 0x1f6274,
  fogDeep: 0x082844,
  waterTop: 0x3f9e90,
  waterDeep: 0x0b3442,
  // The colour light takes inside aerated storm water (see seaMilk).
  seaMilk: 0x6f9a84,
  skyZenith: 0x69787c,
  skyMid: 0xa4aaaa,
  skyMidAway: 0x748386,
  skyHorizon: 0xbfc1bb,
  skyHorizonAway: 0x7c8b8d,
  skyCloud: 0x5f6c70,
  skyLand: 0x3f4a55,
  sandLight: 0x9b8a64,
  sandShade: 0x41402f,
  sandWet: 0x5b5540,
  seagrass: 0x3d6a33,
  seagrassLight: 0x9db35a,
  skinTint: 0x879b9f,
  sunColor: 0xdcd6c8,
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
  { path: "movement.airLiftCoef", label: "air control (lift)", min: 0, max: 0.12, step: 0.005 },
  { path: "movement.airLiftMax", label: "air lift max (m/s2)", min: 0, max: 20, step: 0.5 },
  { path: "movement.airGravity", label: "air gravity", min: 0, max: 14, step: 0.05 },
  { path: "movement.breachImpulse", label: "breach kick", min: 0, max: 6, step: 0.05 },
  { path: "movement.breachBoost", label: "boosted breach (Shift)", min: 0, max: 15, step: 0.1 },
  { path: "movement.airDiveAccel", label: "dive pull in air (Shift)", min: 0, max: 20, step: 0.1 },
  { path: "movement.airDiveDrag", label: "dive air drag", min: 0, max: 1, step: 0.01 },
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
  { path: "water.preset", label: "sea state", type: "preset", options: ["calm", "moderate", "surf", "groundswell", "bigwave", "storm", "mega"] },
  { path: "water.megaHeight", label: "mega wave height", min: 50, max: 900, step: 10 },
  { path: "water.megaFront", label: "mega face width", min: 80, max: 600, step: 10 },
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
  { path: "water.faceSkew", label: "face steepening", min: 0, max: 0.95, step: 0.01 },
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
  { path: "hydro.axialDragScale", label: "axial form drag", min: 0, max: 1, step: 0.01 },
  { path: "hydro.surfaceLock", label: "surface lock (Space)", min: 0, max: 1, step: 1 },
  { path: "hydro.surfaceLeap", label: "leap on release (m/s)", min: 0, max: 16, step: 0.5 },
  { path: "hydro.surfaceLeapForward", label: "leap drive on a wave (m/s)", min: 0, max: 30, step: 0.5 },
  { path: "hydro.glideDownSlope", label: "coast down a face from slope", min: 0.03, max: 0.5, step: 0.01 },
  { path: "hydro.porpoiseLift", label: "porpoise leap", min: 0, max: 0.8, step: 0.01 },
  { path: "hydro.surfaceCarveGrip", label: "surface carve grip", min: 0, max: 12, step: 0.5 },
  { path: "hydro.surfaceTurnResponse", label: "surface turn response", min: 4, max: 20, step: 0.5 },
  { path: "hydro.surfaceLockDepth", label: "surface lock depth", min: 0, max: 1.2, step: 0.05 },
  { path: "hydro.planeDragCut", label: "planing drag cut", min: 0, max: 0.95, step: 0.01 },
  { path: "hydro.diveDragCut", label: "dive drag cut (Shift)", min: 0, max: 0.95, step: 0.01 },
  { path: "hydro.planeSpeed", label: "planing speed", min: 10, max: 40, step: 0.5 },
  { path: "hydro.finLiftSlope", label: "fin lift", min: 0, max: 6, step: 0.05 },
  { path: "hydro.keelLiftSlope", label: "keel grip (path follows nose)", min: 0, max: 6, step: 0.1 },
  { path: "hydro.slamDrag", label: "slam drag", min: 0, max: 8, step: 0.1 },
  { path: "hydro.surfaceTrimRate", label: "surface trim", min: 0, max: 4, step: 0.05 },
  { path: "hydro.rideTrim", label: "ride trim", type: "toggle" },
  { path: "hydro.rideDepth", label: "riding depth", min: 0, max: 1.2, step: 0.05 },
  { path: "hydro.rideRelease", label: "ride release angle", min: 0.15, max: 0.9, step: 0.01 },
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
  { path: "visuals.causticNet", label: "caustic net", min: 0, max: 1, step: 0.01 },
  { path: "visuals.surfaceHaze", label: "surface haze", min: 0, max: 1.5, step: 0.01 },
  { path: "visuals.surfaceMist", label: "sea mist", min: 0, max: 1.5, step: 0.01 },
  { path: "visuals.seaMist", label: "low sea mist", min: 0, max: 4, step: 0.01 },
  { path: "visuals.horizonFog", label: "horizon fog", min: 0, max: 3, step: 0.01 },
  { path: "visuals.whitecaps", label: "whitecaps", min: 0, max: 2.5, step: 0.01 },
  { path: "visuals.foamStreaks", label: "foam streaks", min: 0, max: 2, step: 0.01 },
  { path: "visuals.spindrift", label: "crest spindrift", min: 0, max: 2, step: 0.01 },
  { path: "visuals.seaMilk", label: "milky storm water", min: 0, max: 1, step: 0.01 },
  { path: "visuals.seaGlow", label: "water glow", min: 0.4, max: 2, step: 0.01 },
  { path: "visuals.troughShade", label: "trough shade", min: 0, max: 1, step: 0.01 },
  { path: "visuals.foamWhite", label: "foam whiteness", min: 0.8, max: 3, step: 0.01 },
  { path: "visuals.sunGlitter", label: "sun glitter", min: 0, max: 3, step: 0.01 },
  { path: "audio.surf", label: "surf roar", min: 0, max: 1.5, step: 0.01 },
  { path: "visuals.edgeSmoothing", label: "edge smoothing", type: "toggle" },
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
