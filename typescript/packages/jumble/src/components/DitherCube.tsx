import { useRef } from "react";
import { Canvas, useFrame, extend } from "@react-three/fiber";
import { OrthographicCamera, Effects } from "@react-three/drei";
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

const OrbitingCube = ({
  orbitSpeed,
  orbitRadius,
  phase,
  color,
  rotationAxis = "horizontal",
}: {
  orbitSpeed: number;
  orbitRadius: number;
  phase: number;
  color: string;
  rotationAxis?: "horizontal" | "vertical";
}) => {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (meshRef.current) {
      const time = state.clock.getElapsedTime();

      if (rotationAxis === "horizontal") {
        meshRef.current.position.x = Math.cos(time * orbitSpeed + phase) * orbitRadius;
        meshRef.current.position.z = Math.sin(time * orbitSpeed + phase) * orbitRadius;
      } else {
        meshRef.current.position.x = Math.cos(time * orbitSpeed + phase) * orbitRadius;
        meshRef.current.position.y = Math.sin(time * orbitSpeed + phase) * orbitRadius;
      }

      meshRef.current.rotation.x += 0.01;
      meshRef.current.rotation.y += 0.01;
    }
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[0.8, 0.8, 0.8]} />
      <meshStandardMaterial color={color} roughness={0.2} metalness={0.8} />
    </mesh>
  );
};

type DitheredCubeProps = {
  width?: number;
  height?: number;
  className?: string;
};

const MovingDirectionalLight = () => {
  const lightRef = useRef<THREE.DirectionalLight>(null);

  useFrame((state) => {
    if (lightRef.current) {
      const time = state.clock.getElapsedTime();
      lightRef.current.position.x = Math.sin(time * 0.5) * 5;
      lightRef.current.position.y = Math.cos(time * 0.3) * 5;
      lightRef.current.position.z = Math.sin(time * 0.4) * 5;
    }
  });

  return <directionalLight ref={lightRef} position={[5, 5, 5]} intensity={10} />;
};

export const DitheredCube = ({ width = 512, height = 512, className }: DitheredCubeProps) => {
  // Create arrays for cube positions in both rings
  const horizontalCubes = Array.from({ length: 8 }, (_, i) => ({
    phase: (i * Math.PI * 2) / 8,
    color: `hsl(${(i * 360) / 8}, 70%, 60%)`,
  }));

  const verticalCubes = Array.from({ length: 8 }, (_, i) => ({
    phase: (i * Math.PI * 2) / 8,
    color: `hsl(${(i * 360) / 8 + 180}, 70%, 60%)`,
  }));

  return (
    <div style={{ width, height, imageRendering: "pixelated" }} className={className}>
      <Canvas
        dpr={1}
        gl={{
          antialias: false,
        }}
      >
        <OrthographicCamera makeDefault position={[0, 0, 5]} zoom={50} near={0.1} far={1000} />
        <ambientLight intensity={0.2} />
        <MovingDirectionalLight />
        {horizontalCubes.map((cube, i) => (
          <OrbitingCube
            key={`h-${i}`}
            orbitSpeed={1.5}
            orbitRadius={2}
            phase={cube.phase}
            color={cube.color}
            rotationAxis="horizontal"
          />
        ))}
        {verticalCubes.map((cube, i) => (
          <OrbitingCube
            key={`v-${i}`}
            orbitSpeed={1.3}
            orbitRadius={2}
            phase={cube.phase}
            color={cube.color}
            rotationAxis="vertical"
          />
        ))}
        <Effects>
          <ditheringPass />
        </Effects>
      </Canvas>
    </div>
  );
};
