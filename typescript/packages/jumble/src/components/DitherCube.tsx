import { useRef, useState, useEffect } from "react";
import { Canvas, useFrame, extend } from "@react-three/fiber";
import { OrthographicCamera, Effects, OrbitControls } from "@react-three/drei";
import * as THREE from "three";

// @ts-expect-error no types provided
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass";

// Define the shader
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

      float final = grey > threshold ? 0.0 : 1.0;
      gl_FragColor = vec4(vec3(final), 1.0);
    }
  `,
};

// Create a proper class for the pass
class DitheringPassClass extends ShaderPass {
  constructor() {
    super(DitheringShader);
  }
}

// Extend the pass
extend({ DitheringPass: DitheringPassClass });
function MorphingMesh() {
  const meshRef = useRef<THREE.Mesh>();

  useEffect(() => {
    if (!meshRef.current) return;

    // Create base icosphere
    const baseGeometry = new THREE.IcosahedronGeometry(1, 1); // subdivision level 1
    const vertexCount = baseGeometry.attributes.position.count;

    // Helper function to map icosphere vertices to target shape positions
    const createMorphTarget = (shapeFn: (t: THREE.Vector3) => THREE.Vector3) => {
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
        return v.clone().multiplyScalar(1 / max);
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
      }
    ];

    // Create morph targets
    baseGeometry.morphAttributes.position = shapes.map(shapeFn =>
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

    const time = state.clock.getElapsedTime();
    const influences = meshRef.current.morphTargetInfluences;

    if (!influences) return;

    // Animate each influence with an offset
    influences.forEach((_, index) => {
      influences[index] = Math.sin(time + index * Math.PI * 0.5) * 0.5 + 0.5;
    });
  });

  return (
    <mesh ref={meshRef}>
      <meshNormalMaterial morphTargets />
    </mesh>
  );
}
type DitheredCubeProps = {
  width?: number;
  height?: number;
  className?: string;
};

export const DitheredCube = ({ width = 512, height = 512, className }: DitheredCubeProps) => {
  return (
    <div style={{ width, height, imageRendering: "pixelated" }} className={className}>
      <Canvas
        dpr={1}
        gl={{
          antialias: false,
        }}
      >
        <OrthographicCamera makeDefault position={[0, 0, 5]} zoom={50} near={0.1} far={1000} />
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} />
        <MorphingMesh />
        <OrbitControls enableZoom={true} />
        <Effects>
          <ditheringPass />
        </Effects>
      </Canvas>
    </div>
  );
};
