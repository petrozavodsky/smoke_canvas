'use strict'
const canvas = document.getElementById('pretty-bg')
if (canvas) {
  canvas.width = canvas.clientWidth
  canvas.height = canvas.clientHeight

  let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 0.99,
    VELOCITY_DISSIPATION: 0.98,
    PRESSURE_DISSIPATION: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 20,
    SPLAT_RADIUS: 0.8,
    SHADING: true,
    COLORFUL: true,
    PAUSED: false,
    BACK_COLOR: {
      r: 0,
      g: 0,
      b: 0
    },
    TRANSPARENT: true
  }

  function pointerPrototype () {
    this.id = -1
    this.x = 0
    this.y = 0
    this.dx = 0
    this.dy = 0
    this.down = false
    this.moved = false
    this.color = [30, 0, 300]
  }

  let pointers = []
  let splatStack = []
  pointers.push(new pointerPrototype())

  const {
    gl,
    ext
  } = getWebGLContext(canvas)

  if (isMobile()) {
    config.DYE_RESOLUTION = 128
    config.SHADING = false
  }
  if (!ext.supportLinearFiltering)
    config.SHADING = false

  function getWebGLContext (canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false
    }

    let gl = canvas.getContext('webgl2', params)
    const isWebGL2 = !!gl
    if (!isWebGL2)
      gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params)

    let halfFloat
    let supportLinearFiltering
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float')
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear')
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float')
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear')
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0)

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES
    let formatRGBA
    let formatRG
    let formatR

    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType)
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType)
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType)
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType)
      formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType)
      formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType)
    }

    return {
      gl,
      ext: {
        formatRGBA,
        formatRG,
        formatR,
        halfFloatTexType,
        supportLinearFiltering
      }
    }
  }

  function getSupportedFormat (gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F:
          return getSupportedFormat(gl, gl.RG16F, gl.RG, type)
        case gl.RG16F:
          return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type)
        default:
          return null
      }
    }

    return {
      internalFormat,
      format
    }
  }

  function supportRenderTextureFormat (gl, internalFormat, format, type) {
    let texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null)

    let fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status != gl.FRAMEBUFFER_COMPLETE)
      return false
    return true
  }

  function clamp01 (input) {
    return Math.min(Math.max(input, 0), 1)
  }

  function isMobile () {
    return /Mobi|Android/i.test(navigator.userAgent)
  }

  class GLProgram {
    constructor (vertexShader, fragmentShader) {
      this.uniforms = {}
      this.program = gl.createProgram()

      gl.attachShader(this.program, vertexShader)
      gl.attachShader(this.program, fragmentShader)
      gl.linkProgram(this.program)

      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw gl.getProgramInfoLog(this.program)

      const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS)
      for (let i = 0; i < uniformCount; i++) {
        const uniformName = gl.getActiveUniform(this.program, i).name
        this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName)
      }
    }

    bind () {
      gl.useProgram(this.program)
    }
  }

  function compileShader (type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw gl.getShaderInfoLog(shader)

    return shader
  }

  const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`)

  const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`)

  const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`)

  const backgroundShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`)

  const displayShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec3 C = texture2D(uTexture, vUv).rgb;
        float a = max(C.r, max(C.g, C.b));
        gl_FragColor = vec4(C, a);
    }
`)

  const displayShadingShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform vec2 texelSize;

    void main () {
        vec3 L = texture2D(uTexture, vL).rgb;
        vec3 R = texture2D(uTexture, vR).rgb;
        vec3 T = texture2D(uTexture, vT).rgb;
        vec3 B = texture2D(uTexture, vB).rgb;
        vec3 C = texture2D(uTexture, vUv).rgb;

        float dx = length(R) - length(L);
        float dy = length(T) - length(B);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        C.rgb *= diffuse;

        float a = max(C.r, max(C.g, C.b));
        gl_FragColor = vec4(C, a);
    }
`)

  const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`)

  const advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize);
        gl_FragColor.a = 1.0;
    }
`)

  const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform float dt;
    uniform float dissipation;

    void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        gl_FragColor = dissipation * texture2D(uSource, coord);
        gl_FragColor.a = 1.0;
    }
`)

  const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`)

  const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`)

  const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 vel = texture2D(uVelocity, vUv).xy;
        gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
    }
`)

  const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    vec2 boundary (vec2 uv) {
        return uv;
        // uncomment if you use wrap or repeat texture mode
        // uv = min(max(uv, 0.0), 1.0);
        // return uv;
    }

    void main () {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`)

  const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    vec2 boundary (vec2 uv) {
        return uv;
        // uv = min(max(uv, 0.0), 1.0);
        // return uv;
    }

    void main () {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`)

  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(0)

    return (destination) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination)
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
    }
  })()

  let simWidth
  let simHeight
  let dyeWidth
  let dyeHeight
  let density
  let velocity
  let divergence
  let curl
  let pressure

  const clearProgram = new GLProgram(baseVertexShader, clearShader)
  const colorProgram = new GLProgram(baseVertexShader, colorShader)
  const backgroundProgram = new GLProgram(baseVertexShader, backgroundShader)
  const displayProgram = new GLProgram(baseVertexShader, displayShader)
  const displayShadingProgram = new GLProgram(baseVertexShader, displayShadingShader)
  const splatProgram = new GLProgram(baseVertexShader, splatShader)
  const advectionProgram = new GLProgram(baseVertexShader, ext.supportLinearFiltering ? advectionShader : advectionManualFilteringShader)
  const divergenceProgram = new GLProgram(baseVertexShader, divergenceShader)
  const curlProgram = new GLProgram(baseVertexShader, curlShader)
  const vorticityProgram = new GLProgram(baseVertexShader, vorticityShader)
  const pressureProgram = new GLProgram(baseVertexShader, pressureShader)
  const gradienSubtractProgram = new GLProgram(baseVertexShader, gradientSubtractShader)

  function initFramebuffers () {
    let simRes = getResolution(config.SIM_RESOLUTION)
    let dyeRes = getResolution(config.DYE_RESOLUTION)

    simWidth = simRes.width
    simHeight = simRes.height
    dyeWidth = dyeRes.width
    dyeHeight = dyeRes.height

    const texType = ext.halfFloatTexType
    const rgba = ext.formatRGBA
    const rg = ext.formatRG
    const r = ext.formatR

    density = createDoubleFBO(2, dyeWidth, dyeHeight, rgba.internalFormat, rgba.format, texType, ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST)
    velocity = createDoubleFBO(0, simWidth, simHeight, rg.internalFormat, rg.format, texType, ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST)
    divergence = createFBO(4, simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST)
    curl = createFBO(5, simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST)
    pressure = createDoubleFBO(6, simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST)
  }

  function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight
    if (aspectRatio < 1)
      aspectRatio = 1.0 / aspectRatio

    let max = Math.round(resolution * aspectRatio)
    let min = Math.round(resolution)

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
      return {
        width: max,
        height: min
      }
    else
      return {
        width: min,
        height: max
      }
  }

  function createFBO (texId, w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0 + texId)
    let texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

    let fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.viewport(0, 0, w, h)
    gl.clear(gl.COLOR_BUFFER_BIT)

    return {
      texture,
      fbo,
      texId
    }
  }

  function createDoubleFBO (texId, w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(texId, w, h, internalFormat, format, type, param)
    let fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param)

    return {
      get read () {
        return fbo1
      },
      get write () {
        return fbo2
      },
      swap () {
        let temp = fbo1
        fbo1 = fbo2
        fbo2 = temp
      }
    }
  }

  initFramebuffers()

  let lastColorChangeTime = Date.now()

  update()

  function update () {
    resizeCanvas()
    input()
    if (!config.PAUSED)
      step(0.016)
    render(null)
    requestAnimationFrame(update)
  }

  function input () {
    if (splatStack.length > 0)
      multipleSplats(splatStack.pop())

    for (let i = 0; i < pointers.length; i++) {
      const p = pointers[i]
      if (p.moved) {
        splat(p.x, p.y, p.dx, p.dy, p.color)
        p.moved = false
      }
    }

    if (!config.COLORFUL)
      return

    if (lastColorChangeTime + 100 < Date.now()) {
      lastColorChangeTime = Date.now()
      for (let i = 0; i < pointers.length; i++) {
        const p = pointers[i]
        p.color = generateColor()
      }
    }
  }

  function step (dt) {
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, simWidth, simHeight)

    curlProgram.bind()
    gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.texId)
    blit(curl.fbo)

    vorticityProgram.bind()
    gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.texId)
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.texId)
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL)
    gl.uniform1f(vorticityProgram.uniforms.dt, dt)
    blit(velocity.write.fbo)
    velocity.swap()

    divergenceProgram.bind()
    gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.texId)
    blit(divergence.fbo)

    clearProgram.bind()
    let pressureTexId = pressure.read.texId
    gl.activeTexture(gl.TEXTURE0 + pressureTexId)
    gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture)
    gl.uniform1i(clearProgram.uniforms.uTexture, pressureTexId)
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION)
    blit(pressure.write.fbo)
    pressure.swap()

    pressureProgram.bind()
    gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.texId)
    pressureTexId = pressure.read.texId
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressureTexId)
    gl.activeTexture(gl.TEXTURE0 + pressureTexId)
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture)
      blit(pressure.write.fbo)
      pressure.swap()
    }

    gradienSubtractProgram.bind()
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.texId)
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.texId)
    blit(velocity.write.fbo)
    velocity.swap()

    advectionProgram.bind()
    gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
    if (!ext.supportLinearFiltering)
      gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / simWidth, 1.0 / simHeight)
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.texId)
    gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read.texId)
    gl.uniform1f(advectionProgram.uniforms.dt, dt)
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION)
    blit(velocity.write.fbo)
    velocity.swap()

    gl.viewport(0, 0, dyeWidth, dyeHeight)

    if (!ext.supportLinearFiltering)
      gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / dyeWidth, 1.0 / dyeHeight)
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.texId)
    gl.uniform1i(advectionProgram.uniforms.uSource, density.read.texId)
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION)
    blit(density.write.fbo)
    density.swap()
  }

  function render (target) {
    if (target == null || !config.TRANSPARENT) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.enable(gl.BLEND)
    } else {
      gl.disable(gl.BLEND)
    }

    let width = target == null ? gl.drawingBufferWidth : dyeWidth
    let height = target == null ? gl.drawingBufferHeight : dyeHeight

    gl.viewport(0, 0, width, height)

    if (!config.TRANSPARENT) {
      colorProgram.bind()
      let bc = config.BACK_COLOR
      gl.uniform4f(colorProgram.uniforms.color, bc.r / 255, bc.g / 255, bc.b / 255, 1)
      blit(target)
    }

    if (target == null && config.TRANSPARENT) {
      backgroundProgram.bind()
      // gl.uniform1f(backgroundProgram.uniforms.aspectRatio, canvas.width / canvas.height);
      // blit(null);
    }

    if (config.SHADING) {
      displayShadingProgram.bind()
      gl.uniform2f(displayShadingProgram.uniforms.texelSize, 1.0 / width, 1.0 / height)
      gl.uniform1i(displayShadingProgram.uniforms.uTexture, density.read.texId)
    } else {
      displayProgram.bind()
      gl.uniform1i(displayProgram.uniforms.uTexture, density.read.texId)
    }

    blit(target)
  }

  function splat (x, y, dx, dy, color) {
    gl.viewport(0, 0, simWidth, simHeight)
    splatProgram.bind()
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.texId)
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height)
    gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height)
    gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0)
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0)
    blit(velocity.write.fbo)
    velocity.swap()

    gl.viewport(0, 0, dyeWidth, dyeHeight)
    gl.uniform1i(splatProgram.uniforms.uTarget, density.read.texId)
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b)
    blit(density.write.fbo)
    density.swap()
  }

  function multipleSplats (amount, move = false) {
    for (let i = 0; i < amount; i++) {
      const color = generateColor()
      color.r *= 10.0
      color.g *= 10.0
      color.b *= 10.0
      var x = canvas.width * Math.random()
      var y = canvas.height * Math.random()
      var dx = 1000 * (Math.random() - 0.5)
      var dy = 1000 * (Math.random() - 0.5)
      if (move) {
        x = canvas.width / 2
        y = canvas.height / 2
        dx = 1000 * (Math.random() - 0.5)
        dy = 1000 * (Math.random() - 0.5)
      }
      splat(x, y, dx, dy, color)
    }
  }

  function resizeCanvas () {
    if (canvas.width != canvas.clientWidth || canvas.height != canvas.clientHeight) {
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
      initFramebuffers()
    }
  }

  // setInterval(function(){
  //     multipleSplats(1, true);
  // },900)
  var my_dx = 0
  var my_dy = 0
  var my_color = generateColor()
  canvas.addEventListener('mousemove', e => {

    splat(e.offsetX, e.offsetY, (e.offsetX - my_dx) * 5, (e.offsetY - my_dy) * 5, my_color)
    my_dx = e.offsetX
    my_dy = e.offsetY
  })

  setInterval(function () {
    my_color = generateColor()
  }, 500)

  // var f = true;
  canvas.addEventListener('touchmove', e => {
    // if (f){
    //     f = false;
    // }
    // multipleSplats(1, true);
    e.preventDefault()
    const touches = e.targetTouches
    for (let i = 0; i < touches.length; i++) {
      let pointer = pointers[i]
      pointer.moved = pointer.down
      pointer.dx = (touches[i].pageX - pointer.x) * 8.0
      pointer.dy = (touches[i].pageY - pointer.y) * 8.0
      pointer.x = touches[i].pageX
      pointer.y = touches[i].pageY
    }
  }, false)

  // canvas.addEventListener('mousedown', () => {
  //     pointers[0].color = generateColor();
  // });
  // pointers[0].color = generateColor();

  canvas.addEventListener('touchstart', e => {
    e.preventDefault()
    const touches = e.targetTouches
    for (let i = 0; i < touches.length; i++) {
      if (i >= pointers.length)
        pointers.push(new pointerPrototype())

      pointers[i].id = touches[i].identifier
      pointers[i].down = true
      pointers[i].x = touches[i].pageX
      pointers[i].y = touches[i].pageY
      pointers[i].color = generateColor()
    }
  })

  window.addEventListener('mouseup', () => {
    pointers[0].down = false
  })

  window.addEventListener('touchend', e => {
    const touches = e.changedTouches
    for (let i = 0; i < touches.length; i++)
      for (let j = 0; j < pointers.length; j++)
        if (touches[i].identifier == pointers[j].id)
          pointers[j].down = false
  })

  window.addEventListener('keydown', e => {
    if (e.key === 'p')
      config.PAUSED = !config.PAUSED
  })

  function generateColor () {
    // let c = HSVtoRGB(0.2518, 0.9430, 0.7569);
    // var f = Math.random(1);
    // console.log(f);
    // let colors = [
    //     HSVtoRGB(0.4713, 0.4819, 0.7569),
    //     HSVtoRGB(0.6104, 0.3776, 0.7686),
    //     HSVtoRGB(0.0254, 0.5481, 0.9373),
    //     HSVtoRGB(0.0608, 0.4948, 0.7608),
    //     HSVtoRGB(0.6140, 0.0748, 0.9961),
    // ]
    // let first = HSVtoRGB(0.4713, 0.4819, 0.7569);
    // let second = HSVtoRGB(0.6104, 0.3776, 0.7686);
    // let third = HSVtoRGB(0.0254, 0.5481, 0.9373);
    // let fourth = HSVtoRGB(0.0608, 0.4948, 0.7608);
    // let fifth = HSVtoRGB(0.6140, 0.0748, 0.9961);
    // let f = getRandomInt(0,4);

    // let c;

    // c = colors[f];
    // let c = {
    //     r = 100,
    //     g = 193,
    //     b = 177
    //     };
    // console.log(c);
    // c.r *= 0.1;
    // c.g *= 0.1;
    // c.b *= 0.1;
    let c = HSVtoRGB(Math.random(), 1.0, 1.0)
    c.r *= 0.15
    c.g *= 0.15
    c.b *= 0.15
    return c
    return c
  }

  function getRandomInt (min, max) {
    min = Math.ceil(min)
    max = Math.floor(max)
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  function HSVtoRGB (h, s, v) {
    let r, g, b, i, f, p, q, t
    i = Math.floor(h * 6)
    f = h * 6 - i
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)

    switch (i % 6) {
      case 0:
        r = v, g = t, b = p
        break
      case 1:
        r = q, g = v, b = p
        break
      case 2:
        r = p, g = v, b = t
        break
      case 3:
        r = p, g = q, b = v
        break
      case 4:
        r = t, g = p, b = v
        break
      case 5:
        r = v, g = p, b = q
        break
    }

    return {
      r,
      g,
      b
    }
  }
}
