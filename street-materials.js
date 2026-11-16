import * as THREE from "three";

const decodeSRGB = `
  vec3 decodeSRGB(vec3 rgb) {
    return mix(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), rgb));
  }
`;

export function textureArray(pixels, size, count, colorSpace = THREE.NoColorSpace) {
  const texture = new THREE.DataArrayTexture(pixels, size, size, count);
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export async function readTextureArray(folder, entries, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = new Uint8Array(size * size * 4 * entries.length);
  const images = await Promise.all(entries.map(async ({ name }) => {
    const response = await fetch(new URL(`${name}.webp`, folder));
    if (!response.ok) throw new Error(`材质加载失败：${name}`);
    return createImageBitmap(await response.blob(), { premultiplyAlpha: "none" });
  }));
  for (const [i, image] of images.entries()) {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);
    pixels.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4);
    image.close();
  }
  return textureArray(pixels, size, entries.length, THREE.SRGBColorSpace);
}

const layerVaryings = `
  flat varying float vStreetLayer;
  varying vec3 vStreetWorld;
`;

export function groundMaterial(map, entries) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.96, polygonOffset: true, polygonOffsetFactor: -1 });
  const scales = entries.map(layer => 1 / layer.metres);
  material.onBeforeCompile = shader => {
    shader.uniforms.streetGround = { value: map };
    shader.uniforms.streetGroundScale = { value: scales };
    shader.vertexShader = `attribute float layer; ${layerVaryings}\n` + shader.vertexShader
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vStreetLayer = layer;
        vStreetWorld = position;
      `);
    shader.fragmentShader = `${layerVaryings}
      uniform highp sampler2DArray streetGround;
      uniform float streetGroundScale[${entries.length}];
    ` + shader.fragmentShader.replace("#include <map_fragment>", `
      int layerIndex = int(vStreetLayer + 0.5);
      if (layerIndex < 0 || layerIndex >= ${entries.length}) layerIndex = 1;
      vec2 groundUV = vStreetWorld.xz * streetGroundScale[layerIndex];
      diffuseColor.rgb *= texture(streetGround, vec3(groundUV, float(layerIndex))).rgb;
    `);
  };
  return material;
}

export function buildingMaterial(dwelling, parametric, storefronts, metadata, night) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.83 });
  const regularGrid = metadata.facades.map(({ bays, floors }) => new THREE.Vector2(bays, floors));
  const proceduralGrid = metadata.procedural.map(([bays, floors]) => new THREE.Vector2(bays, floors));
  material.onBeforeCompile = shader => {
    shader.uniforms.streetFacade = { value: dwelling };
    shader.uniforms.streetParametric = { value: parametric };
    shader.uniforms.streetStorefronts = { value: storefronts };
    shader.uniforms.streetFacadeGrid = { value: regularGrid };
    shader.uniforms.streetParametricGrid = { value: proceduralGrid };
    shader.uniforms.streetNight = night;
    shader.vertexShader = `attribute float layer;
      attribute vec3 paint;
      varying vec2 vStreetUV;
      flat varying vec3 vStreetPaint;
      flat varying float vWallPlane;
      flat varying float vStreetLayer;
    ` + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vStreetLayer = layer;
      vStreetPaint = paint;
      vStreetUV = uv;
      vWallPlane = floor(dot(normal, position) * 0.31 + 0.37);
    `);
    shader.fragmentShader = `
      ${decodeSRGB}
      flat varying float vStreetLayer;
      varying vec2 vStreetUV;
      flat varying vec3 vStreetPaint;
      flat varying float vWallPlane;
      uniform highp sampler2DArray streetFacade;
      uniform highp sampler2DArray streetParametric;
      uniform sampler2D streetStorefronts;
      uniform vec2 streetFacadeGrid[${regularGrid.length}];
      uniform vec2 streetParametricGrid[${proceduralGrid.length}];
      uniform float streetNight;

      vec3 facadeColor(float value, vec3 fallback) {
        if (value == 0.0) return fallback;
        return decodeSRGB(mod(floor(value / vec3(65536.0, 256.0, 1.0)), 256.0) / 255.0);
      }
    ` + shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      int facadeIndex = int(vStreetLayer + 0.5);
      vec2 grid = vec2(1.0);
      float glass = 0.0;
      float litDetail = 1.0;
      bool shopfront = false;
      if (facadeIndex >= 64) {
        facadeIndex = int(mod(float(facadeIndex - 64), 40.0));
        if (facadeIndex < ${proceduralGrid.length}) {
          vec4 f = texture(streetParametric, vec3(vStreetUV, float(facadeIndex)));
          vec3 wall = diffuseColor.rgb;
          vec3 trim = facadeColor(vStreetPaint.r, wall * 1.24);
          vec3 accent = facadeColor(vStreetPaint.g, wall * 0.62);
          vec3 body = mix(wall, trim, f.g);
          body = mix(body, mix(accent, vec3(0.44), f.g), f.b);
          glass = 1.0 - smoothstep(0.65, 0.86, f.a);
          vec3 glazing = facadeColor(vStreetPaint.b, vec3(0.055, 0.085, 0.108));
          diffuseColor.rgb = mix(body, glazing, glass) * f.r;
          grid = streetParametricGrid[facadeIndex];
          shopfront = facadeIndex == 16;
          litDetail = 0.25 + f.r * 0.85;
        }
      } else if (facadeIndex >= 0 && facadeIndex < ${regularGrid.length}) {
        vec4 f = texture(streetFacade, vec3(vStreetUV, float(facadeIndex)));
        diffuseColor.rgb *= f.rgb;
        glass = 1.0 - smoothstep(0.64, 0.88, f.a);
        grid = streetFacadeGrid[facadeIndex];
        litDetail = 0.48 + dot(f.rgb, vec3(0.13, 0.32, 0.1));
      }
      vec2 windowCell = floor(vStreetUV * grid);
      float seed = fract(sin(dot(windowCell + vec2(vWallPlane, vWallPlane * 0.31),
                                 vec2(27.173, 57.392))) * 43758.5453);
      vec3 windowColor = mix(vec3(1.35, 0.89, 0.51), vec3(0.81, 0.91, 1.10), step(0.83, seed));
      float windowLight = glass * litDetail * streetNight * step(0.70, seed);
      vec3 signLight = vec3(0.0);
      if (shopfront) {
        vec2 local = fract(vStreetUV * grid);
        if (local.x > 0.025 && local.x < 0.975 && local.y > 0.035 && local.y < 0.265) {
          float signIndex = floor(seed * 256.0);
          vec2 cell = vec2(mod(signIndex, 8.0), floor(signIndex / 8.0));
          vec2 inSign = vec2(1.0 - (local.x - 0.025) / 0.95, (local.y - 0.035) / 0.23);
          diffuseColor.rgb = texture2D(streetStorefronts, (cell + inSign) / vec2(8.0, 32.0)).rgb;
          windowLight = 0.0;
          signLight = diffuseColor.rgb * (0.12 + streetNight * 1.2);
        } else {
          windowLight *= 0.12;
        }
      }
    `).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      totalEmissiveRadiance += windowColor * windowLight + signLight;
    `);
  };
  return material;
}

export function makeSky(night, twilight, sun) {
  return new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 18), new THREE.ShaderMaterial({
    uniforms: { streetNight: night, streetTwilight: twilight, streetSun: sun },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 skyDirection;
      uniform float streetNight;
      uniform float streetTwilight;
      uniform vec3 streetSun;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(123.34, 456.21))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)), f.x), f.y);
      }
      void main() {
        vec3 dir = normalize(skyDirection);
        float altitude = max(dir.y, 0.0);
        float gradient = pow(1.0 - altitude, 3.0);
        vec3 day = mix(vec3(0.075,0.23,0.48), vec3(0.52,0.71,0.79), gradient);
        vec3 night = mix(vec3(0.002,0.004,0.016), vec3(0.015,0.033,0.079), gradient);
        float horizon = smoothstep(0.005, 0.10, altitude);
        vec2 clouds = dir.xz * 2.1 / (altitude + 0.20);
        float billow = noise(clouds) * 0.57 + noise(clouds*2.1)*0.27 +
                       noise(clouds*4.3)*0.12 + noise(clouds*8.6)*0.04;
        float coverage = smoothstep(0.50, 0.69, billow) * horizon;
        vec2 sky = vec2(atan(dir.z, dir.x), asin(dir.y)) * 145.0;
        float stars = step(0.992, hash(floor(sky))) * (1.0 - smoothstep(0.03, 0.16, length(fract(sky)-0.5)));
        day = mix(day, vec3(0.75,0.81,0.87), coverage * 0.64);
        night += vec3(0.39,0.43,0.56) * stars * horizon;
        night = mix(night, vec3(0.088,0.109,0.163), coverage * 0.94);
        vec3 skyColor = mix(day, night, streetNight);
        float warmth = streetTwilight * exp(-altitude * 4.7);
        float facing = smoothstep(-0.3, 0.95, dot(dir, streetSun));
        skyColor += vec3(0.24, 0.071, 0.017) * warmth * (0.32 + facing * 0.68);
        gl_FragColor = vec4(skyColor, 1.0);
        #include <colorspace_fragment>
      }
    `
  }));
}
