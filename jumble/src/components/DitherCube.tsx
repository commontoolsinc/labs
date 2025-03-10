import { useEffect, useRef } from "react";
import { Canvas, extend, useFrame } from "@react-three/fiber";
import { Effects, OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";

import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const easeOutCubic = (x: number): number => {
  return 1 - Math.pow(1 - x, 3);
};

const DitheringShader = {
  uniforms: {
    tDiffuse: { value: null },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;

    float bayerMatrix[16] = float[16](
      0.0/16.0, 8.0/16.0, 2.0/16.0, 10.0/16.0,
      12.0/16.0, 4.0/16.0, 14.0/16.0, 6.0/16.0,
      3.0/16.0, 11.0/16.0, 1.0/16.0, 9.0/16.0,
      15.0/16.0, 7.0/16.0, 13.0/16.0, 5.0/16.0
    );

    void main() {
      vec2 pixelCoord = floor(vUv * vec2(256.0));
      vec2 quadCoord = floor(mod(pixelCoord, 2.0));
      vec2 newUv = floor(vUv * vec2(128.0)) / vec2(128.0);

      vec4 color = texture2D(tDiffuse, newUv);
      float grey = dot(color.rgb, vec3(0.299, 0.587, 0.114));

      int index = int(mod(pixelCoord.x, 4.0)) * 4 + int(mod(pixelCoord.y, 4.0));
      float threshold = bayerMatrix[index];

      if (grey > 0.01) { // You might need to adjust this threshold
        if (grey > threshold) {
          gl_FragColor = vec4(vec3(0.588), 1.0);
        } else {
          gl_FragColor = vec4(vec3(1.0), 0.0);
        }
      } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
      }
    }
  `,
};

class DitheringPassClass extends ShaderPass {
  constructor() {
    super(DitheringShader);
  }
}

extend({ DitheringPass: DitheringPassClass });
function MorphingMesh({
  animate = true,
  animationSpeed = 1,
}: {
  animate?: boolean;
  animationSpeed?: number;
}) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const startAnimationRef = useRef({
    started: false,
    startTime: 0,
  });

  useEffect(() => {
    if (!meshRef.current) return;

    // Create base icosphere
    const baseGeometry = new THREE.IcosahedronGeometry(1, 1); // subdivision level 1
    const vertexCount = baseGeometry.attributes.position.count;

    // Helper function to map icosphere vertices to target shape positions
    const createMorphTarget = (
      shapeFn: (t: THREE.Vector3) => THREE.Vector3,
    ) => {
      const positions = new Float32Array(vertexCount * 3);
      const positionAttribute = baseGeometry.attributes.position;
      const tempVector = new THREE.Vector3();

      for (let i = 0; i < vertexCount; i++) {
        tempVector.fromBufferAttribute(positionAttribute, i);
        // Normalize to get direction from center
        tempVector.normalize();
        // Map to target shape
        const targetPos = shapeFn(tempVector);
        positions[i * 3] = targetPos.x;
        positions[i * 3 + 1] = targetPos.y;
        positions[i * 3 + 2] = targetPos.z;
      }

      return new THREE.BufferAttribute(positions, 3);
    };

    // Shape mapping functions
    const shapes = [
      // Cube
      (v: THREE.Vector3) => {
        const abs = v.clone().set(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
        const max = Math.max(abs.x, abs.y, abs.z);
        return v.clone().multiplyScalar(0.66 / max);
      },
      // Sphere (already spherical, just needs radius adjustment)
      (v: THREE.Vector3) => v.clone().multiplyScalar(0.8),
      // Octahedron
      (v: THREE.Vector3) => {
        const sum = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
        return v.clone().multiplyScalar(1 / sum);
      },
      // Cylinder
      (v: THREE.Vector3) => {
        const cylinderV = v.clone();
        const radius = Math.sqrt(v.x * v.x + v.z * v.z);
        if (radius > 0) {
          cylinderV.x *= 0.7 / radius;
          cylinderV.z *= 0.7 / radius;
        }
        cylinderV.y *= 1.2;
        return cylinderV;
      },
      // Cone
      (v: THREE.Vector3) => {
        const coneV = v.clone();
        const radius = Math.sqrt(v.x * v.x + v.z * v.z);
        if (radius > 0) {
          const scale = (1 - (v.y + 1) * 0.5) * 0.8;
          coneV.x *= scale / radius;
          coneV.z *= scale / radius;
        }
        coneV.y *= 1.2;
        return coneV;
      },
    ];

    // Create morph targets
    baseGeometry.morphAttributes.position = shapes.map((shapeFn) =>
      createMorphTarget(shapeFn)
    );

    // Update mesh geometry
    meshRef.current.geometry = baseGeometry;
    meshRef.current.morphTargetInfluences = new Array(shapes.length).fill(0);

    return () => {
      baseGeometry.dispose();
    };
  }, []);

  useFrame((state) => {
    if (!meshRef.current) return;

    // Multiply time by speed factor
    const time = state.clock.getElapsedTime() * animationSpeed;
    const influences = meshRef.current.morphTargetInfluences;

    if (!influences) return;

    // Initial scale-up animation (keep this independent of speed)
    if (!startAnimationRef.current.started) {
      startAnimationRef.current.started = true;
      startAnimationRef.current.startTime = state.clock.getElapsedTime(); // Use raw time here
    }

    const startProgress = Math.min(
      (state.clock.getElapsedTime() - startAnimationRef.current.startTime) /
        0.3,
      1.0,
    );
    const startScale = easeOutCubic(startProgress);

    if (!animate) {
      influences.fill(0);
      influences[0] = 1;

      // Even in static mode, apply the speed to the rotation
      meshRef.current.rotation.set(0, time * 0.5, 0);
      meshRef.current.scale.set(startScale, startScale, startScale);
      meshRef.current.position.set(0, 0, 0);
      return;
    }

    // Animation parameters - keep durations constant regardless of speed
    const restDuration = 0.5;
    const transitionDuration = 0.2;
    const cycleDuration = restDuration + transitionDuration;
    const totalCycles = influences.length;

    const totalTime = time % (totalCycles * cycleDuration);
    const currentCycle = Math.floor(totalTime / cycleDuration);
    const nextCycle = (currentCycle + 1) % totalCycles;

    const cycleTime = totalTime % cycleDuration;
    const isTransitioning = cycleTime > restDuration;
    const transitionProgress = isTransitioning
      ? 1 - Math.pow(1 - (cycleTime - restDuration) / transitionDuration, 3)
      : 0;

    // Reset all influences to 0
    influences.fill(0);

    // Shape-specific animations
    const animations = [
      {
        // Cube
        rotation: [time * 0.5, time * 0.3, 0],
        scale: [
          1 + Math.sin(time * 2) * 0.2,
          1 + Math.sin(time * 2) * 0.2,
          1 + Math.sin(time * 2) * 0.2,
        ],
        position: [Math.sin(time) * 0.2, 0, 0],
      },
      {
        // Sphere
        rotation: [0, time * 0.8, time * 0.4],
        scale: [
          1 + Math.cos(time * 3) * 0.15,
          1 + Math.cos(time * 3) * 0.15,
          1 + Math.cos(time * 3) * 0.15,
        ],
        position: [0, Math.sin(time * 1.5) * 0.2, 0],
      },
      {
        // Octahedron
        rotation: [time * 0.2, time * 0.6, time * 0.3],
        scale: [
          1 + Math.sin(time * 4) * 0.1,
          1 + Math.sin(time * 4) * 0.1,
          1 + Math.sin(time * 4) * 0.1,
        ],
        position: [Math.cos(time * 2) * 0.15, Math.sin(time * 2) * 0.15, 0],
      },
      {
        // Cylinder
        rotation: [Math.PI / 4, time * 0.4, 0],
        scale: [1, 1 + Math.sin(time * 2.5) * 0.3, 1],
        position: [0, 0, Math.sin(time) * 0.2],
      },
      {
        // Cone
        rotation: [Math.PI / 2 + Math.sin(time) * 0.2, time * 0.7, 0],
        scale: [1, 1 + Math.abs(Math.sin(time * 2)) * 0.5, 1],
        position: [Math.sin(time * 1.2) * 0.2, Math.cos(time * 1.2) * 0.2, 0],
      },
    ];

    // Current and next animation states
    const currentAnim = animations[currentCycle];
    const nextAnim = animations[nextCycle];

    // Interpolate between current and next animation states
    if (isTransitioning) {
      influences[currentCycle] = 1 - transitionProgress;
      influences[nextCycle] = transitionProgress;

      // Interpolate rotation
      meshRef.current.rotation.x = THREE.MathUtils.lerp(
        currentAnim.rotation[0],
        nextAnim.rotation[0],
        transitionProgress,
      );
      meshRef.current.rotation.y = THREE.MathUtils.lerp(
        currentAnim.rotation[1],
        nextAnim.rotation[1],
        transitionProgress,
      );
      meshRef.current.rotation.z = THREE.MathUtils.lerp(
        currentAnim.rotation[2],
        nextAnim.rotation[2],
        transitionProgress,
      );

      // Interpolate scale
      meshRef.current.scale.x = THREE.MathUtils.lerp(
        currentAnim.scale[0],
        nextAnim.scale[0],
        transitionProgress,
      ) *
        startScale;
      meshRef.current.scale.y = THREE.MathUtils.lerp(
        currentAnim.scale[1],
        nextAnim.scale[1],
        transitionProgress,
      ) *
        startScale;
      meshRef.current.scale.z = THREE.MathUtils.lerp(
        currentAnim.scale[2],
        nextAnim.scale[2],
        transitionProgress,
      ) *
        startScale;

      // Interpolate position
      meshRef.current.position.x = THREE.MathUtils.lerp(
        currentAnim.position[0],
        nextAnim.position[0],
        transitionProgress,
      );
      meshRef.current.position.y = THREE.MathUtils.lerp(
        currentAnim.position[1],
        nextAnim.position[1],
        transitionProgress,
      );
      meshRef.current.position.z = THREE.MathUtils.lerp(
        currentAnim.position[2],
        nextAnim.position[2],
        transitionProgress,
      );
    } else {
      influences[currentCycle] = 1;

      // Apply current animation state
      meshRef.current.rotation.set(
        currentAnim.rotation[0],
        currentAnim.rotation[1],
        currentAnim.rotation[2],
      );
      meshRef.current.scale.set(
        currentAnim.scale[0] * startScale,
        currentAnim.scale[1] * startScale,
        currentAnim.scale[2] * startScale,
      );
      meshRef.current.position.set(
        currentAnim.position[0],
        currentAnim.position[1],
        currentAnim.position[2],
      );
    }
  });

  return (
    <mesh ref={meshRef}>
      {/* @ts-expect-error morphTargets typing is wacky, could be user error (bf) */}
      <meshStandardMaterial morphTargets morphNormals />
    </mesh>
  );
}

type DitheredCubeProps = {
  width?: number;
  height?: number;
  className?: string;
  animate?: boolean;
  cameraZoom?: number;
  animationSpeed?: number; // New prop for controlling animation speed
};

export const DitheredCube = ({
  width = 512,
  height = 512,
  className,
  animate = true,
  cameraZoom = 100,
  animationSpeed = 1,
}: DitheredCubeProps) => {
  return (
    <div
      style={{ width, height, imageRendering: "pixelated" }}
      className={className}
    >
      <Canvas
        gl={{
          antialias: false,
          alpha: true,
        }}
      >
        <OrthographicCamera
          makeDefault
          position={[0, 0, 5]}
          zoom={cameraZoom}
          near={0.1}
          far={1000}
        />
        <directionalLight position={[2, 2, 1]} intensity={0.5} />
        <directionalLight position={[-2, -2, 1]} intensity={2} />
        <MorphingMesh animate={animate} animationSpeed={animationSpeed} />
        <OrbitControls enableZoom={false} />
        <Effects>
          <ditheringPass />
        </Effects>
      </Canvas>
    </div>
  );
};
