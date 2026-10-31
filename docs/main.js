/* Flappy Bat — procedural Three.js game, no build step required. */
import { bindInput } from './input.mjs';
import { frameView } from './view.mjs';
import { BAT_START_Y, BAT_X } from './game-rules.mjs';
import { OBSTACLE_COUNT, createFrameClock, createGame, startRun } from './game-core.mjs';

(() => {
  'use strict';
  const THREE = window.THREE;
  if (!THREE) return;

  const $ = (id) => document.getElementById(id);
  const stage = $('game'), sceneHost = $('scene'), scoreEl = $('score'), bestEl = $('best');
  const overlay = $('overlay'), message = $('message'), startButton = $('startButton');
  const restartButton = $('restartButton'), touchHint = $('touchHint');
  const TAU = Math.PI * 2, MAX_PARTICLES = 230;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const choose = (a) => a[Math.floor(Math.random() * a.length)];

  const CAM_FOV = 65;
  // Fog density was tuned for a camera 11 units from the play plane; it is rescaled to the fitted distance.
  const FOG_DENSITY = .027, FOG_REFERENCE_DISTANCE = 11;
  const SHAKE_GAIN = .3; // camera offset in world units per unit of `shake`
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let view; // camera framing from frameView(), refreshed by onResize()
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171116);
  scene.fog = new THREE.FogExp2(0x171116, FOG_DENSITY);
  const camera = new THREE.PerspectiveCamera(CAM_FOV, innerWidth / innerHeight, .1, 130);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sceneHost.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0x776b76, 0x181117, 1.2));
  const ambient = new THREE.AmbientLight(0x372d3a, .75); scene.add(ambient);
  const moon = new THREE.DirectionalLight(0xaaa0c5, 1.4); moon.position.set(-8, 12, 4); scene.add(moon);
  const caveLight = new THREE.PointLight(0x743e36, 2.5, 21, 2); caveLight.position.set(0, -1, 2); scene.add(caveLight);

  const rockMats = [0x403b3d, 0x51474a, 0x625052, 0x352f35, 0x6a5753].map((c, i) => new THREE.MeshStandardMaterial({ color:c, roughness:.96, metalness:.02, flatShading:true, side:THREE.DoubleSide, emissive:i === 2 ? 0x100b0d : 0x000000, emissiveIntensity:.4 }));
  const batMat = new THREE.MeshStandardMaterial({ color:0x332332, roughness:.75, flatShading:true });
  const batWingMat = new THREE.MeshStandardMaterial({ color:0x734454, roughness:.84, side:THREE.DoubleSide, flatShading:true });
  const eyeMat = new THREE.MeshBasicMaterial({ color:0xf5ae67 });

  function makeBat() {
    const outer = new THREE.Group(); outer.position.set(0, 2.2, 0);
    const root = new THREE.Group(); root.rotation.y = -Math.PI / 2; outer.add(root); // model faces -z; turn it to face +x
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(.43, 1), batMat); body.scale.set(.82, 1.2, 1); body.castShadow = true; root.add(body);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(.36, 1), batMat); head.position.set(0,.45,-.06); root.add(head);
    [-1, 1].forEach((s) => {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(.15, .43, 4), batMat); ear.position.set(s*.19,.78,-.04); ear.rotation.z = s * -.18; root.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(.045, 6, 4), eyeMat); eye.position.set(s*.16,.51,-.34); root.add(eye);
    });
    const wingShape = (side) => {
      const g = new THREE.Group(); g.position.set(side*.27,.28,0); root.add(g);
      const pts = [new THREE.Vector3(0,0,0), new THREE.Vector3(side*.5,.28,.02), new THREE.Vector3(side*1.25,.1,.08), new THREE.Vector3(side*1.75,-.24,.14), new THREE.Vector3(side*1.18,-.19,.08), new THREE.Vector3(side*.63,-.02,.03)];
      const geom = new THREE.BufferGeometry(); const pos = []; for (let i=1;i<pts.length-1;i++) pos.push(0,0,0, pts[i].x,pts[i].y,pts[i].z, pts[i+1].x,pts[i+1].y,pts[i+1].z);
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos,3)); geom.computeVertexNormals();
      const membrane = new THREE.Mesh(geom, batWingMat); membrane.scale.set(1.0,1.05,1); g.add(membrane);
      const bones = new THREE.Group(); g.add(bones);
      for (let i=1;i<pts.length-1;i++) { const a=pts[0], b=pts[i]; const d=b.clone().sub(a); const bone=new THREE.Mesh(new THREE.CylinderGeometry(.025,.035,d.length,5), batMat); bone.position.copy(a).add(b).multiplyScalar(.5); bone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), d.normalize()); bones.add(bone); }
      return g;
    };
    const left = wingShape(-1), right = wingShape(1); outer.userData.wings = [left,right];
    const glow = new THREE.PointLight(0xd17c59, 1.8, 4.5, 2); glow.position.set(0,.2,.15); root.add(glow); outer.userData.light = glow;
    return outer;
  }
  const bat = makeBat(); scene.add(bat);

  function makeTunnelSegment(i) {
    const group = new THREE.Group(); group.position.x = i * 8 - 16;
    const n=10, rings=2, verts=[], indices=[];
    // Open half-pipe: only the far wall (z<0) is built so the side-view camera at +z is not blocked.
    for (let r=0;r<rings;r++) for (let j=0;j<=n;j++) { const a=j/n*Math.PI; const radius=5.0 + rand(-.35,.35) + Math.sin(j*2.1+i)*.18; verts.push(r*8-4, Math.cos(a)*radius+1.3, -Math.sin(a)*radius); }
    for (let j=0;j<n;j++) { const a=j, b=j+1, w=n+1; indices.push(a,b,w+b, a,w+b,w+a); }
    const geom=new THREE.BufferGeometry(); geom.setAttribute('position',new THREE.Float32BufferAttribute(verts,3)); geom.setIndex(indices); geom.computeVertexNormals();
    const mesh=new THREE.Mesh(geom, choose(rockMats)); mesh.receiveShadow=true; group.add(mesh);
    for (let j=0;j<3;j++) { const pebble=new THREE.Mesh(new THREE.DodecahedronGeometry(rand(.12,.33),0),choose(rockMats)); const a=rand(0,Math.PI), r=rand(4.75,5.15); pebble.position.set(rand(-3.8,3.8),1.3+Math.cos(a)*r,-Math.sin(a)*r); pebble.rotation.set(rand(0,TAU),rand(0,TAU),rand(0,TAU)); group.add(pebble); }
    return group;
  }
  const tunnel = Array.from({length:18}, (_,i) => { const g=makeTunnelSegment(i); scene.add(g); return g; });

  function pillarPart(height, y, seed) {
    const group = new THREE.Group(); group.position.y=y;
    const geo = new THREE.CylinderGeometry(.62 + seed*.1, .78 + seed*.12, height, 7, 3, false); geo.rotateY(seed*2);
    const mesh = new THREE.Mesh(geo, choose(rockMats)); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
    for(let i=0;i<3;i++){ const cap=new THREE.Mesh(new THREE.DodecahedronGeometry(rand(.18,.4),0),choose(rockMats)); cap.position.set(rand(-.55,.55),rand(-height/2,height/2),rand(-.35,.35)); cap.scale.y=rand(.6,1.8); group.add(cap); }
    return group;
  }
  const PILLAR_HEIGHT = 4.2; // syncObstacles puts the inner end of each pillar on the model's gap edge
  function makeObstacle() { const g=new THREE.Group(); g.add(pillarPart(PILLAR_HEIGHT,0,rand(.1,.9)),pillarPart(PILLAR_HEIGHT,0,rand(.1,.9))); scene.add(g); return g; }
  const obstacles=Array.from({length:OBSTACLE_COUNT},()=>makeObstacle());

  const particleGeo = new THREE.IcosahedronGeometry(.045,0);
  const dustColor = new THREE.Color(0xc18f75);
  const particles=[];
  for(let i=0;i<MAX_PARTICLES;i++){ const material=new THREE.MeshBasicMaterial({color:dustColor,transparent:true,opacity:0}); const m=new THREE.Mesh(particleGeo,material); m.visible=false; scene.add(m); particles.push({mesh:m,life:0,vel:new THREE.Vector3(),gravity:-2}); }
  function burst(pos,count,color,force=.8){ for(let k=0;k<count;k++){ const p=particles.find(x=>!x.mesh.visible); if(!p) break; p.mesh.material.color.set(color); p.mesh.material.opacity=.8; p.mesh.visible=true; p.life=rand(.35,1.2); p.gravity=-2; p.mesh.scale.setScalar(rand(.5,1.8)); p.mesh.position.copy(pos); p.vel.set(rand(-1,1),rand(-.1,1.4),rand(-1,1)).normalize().multiplyScalar(rand(.2,force)); } }
  function dustTrail(){ const p=particles.find(x=>!x.mesh.visible); if(!p) return; p.mesh.material.color.copy(dustColor);p.mesh.material.opacity=.42;p.mesh.visible=true;p.life=rand(.7,1.8);p.gravity=0;p.mesh.position.set(rand(-8,26),rand(-2,6),rand(-4,3));p.vel.set(-rand(2,5),rand(-.1,.1),0); }

  function readBestScore(){ try { const stored=Number(localStorage.getItem('flappyBatBest')); return Number.isFinite(stored) && stored >= 0 ? Math.floor(stored) : 0; } catch (error) { return 0; } }
  function writeBestScore(value){ try { localStorage.setItem('flappyBatBest',String(value)); } catch (error) { /* Keep the in-memory best score when storage is unavailable. */ } }
  // The model owns state, bat physics, score and obstacles; this file renders it and runs effects.
  const game=createGame(), clock=createFrameClock();
  let best=readBestScore(), elapsed=0, shake=0, fallVelocity=0, shownScore=0, scrolled=0;
  bestEl.textContent=best;
  function showScore(){ if(game.score===shownScore) return; shownScore=game.score; scoreEl.textContent=shownScore; }
  function syncObstacles(){ obstacles.forEach((o,i)=>{ const d=game.obstacles[i], offset=d.gapHeight/2+PILLAR_HEIGHT/2; o.position.set(d.x,d.gapY,0); o.children[0].position.y=offset; o.children[1].position.y=-offset; }); }
  function clearEffects(){ shake=0; fallVelocity=0; bat.rotation.z=0; particles.forEach(p=>{p.life=0;p.mesh.visible=false;}); }
  function setReady(){ game.reset(); clearEffects(); scrolled=0; showScore(); bat.position.set(BAT_X,BAT_START_Y,0);message.textContent='';showScreen('ready'); }
  function start(){ if(!startRun(game,clock)) return; showScreen('running'); }
  // Runs once when the model reports a crash: effects, best score and the over screen.
  function gameOver(){ shake=.62; fallVelocity=game.bat.velocity; bat.position.y=game.bat.y; burst(bat.position,38,0xd87554,3.2); burst(bat.position,26,0x8c6570,2.2); const record=game.score>best; if(record){best=game.score;writeBestScore(best);bestEl.textContent=best;} showScreen('over'); showResult(record); }
  function restart(){ setReady(); start(); }
  // `ready` shows the start guide and `over` a compact crash result. While running, the overlay fades out
  // as an inert, pointer-transparent layer, so taps reach the stage and hidden buttons keep no focus.
  function showScreen(phase){ const running=phase==='running'; if(!running) overlay.dataset.phase=phase; overlay.classList.toggle('hidden',running); overlay.inert=running; touchHint.classList.toggle('off',phase!=='ready'); if(running&&overlay.contains(document.activeElement)) document.activeElement.blur(); }
  function showResult(record){ message.innerHTML=`<span class="result-label">통과한 기둥</span><strong class="result-score">${game.score}</strong><span class="result-best${record?' record':''}">${record?'새 최고 기록!':`최고 기록 ${best}`}</span>`; }
  function flap(){ if(game.state==='ready') start(); else if(game.state==='over'){setReady();start();} else game.flap(); }
  function updateBat(dt){ if(game.state==='ready'){bat.position.y=game.bat.y+Math.sin(elapsed*2.1)*.12;} else if(game.state==='running'){bat.position.y=game.bat.y;} else { fallVelocity-=7*dt;bat.position.y+=fallVelocity*dt; bat.rotation.z+=dt*2.5; }
    const pitch=clamp((game.state==='over'?fallVelocity:game.bat.velocity)*.045,-.34,.32); bat.rotation.z += (pitch-bat.rotation.z)*Math.min(dt*8,1); const flap=game.state==='over'?0:Math.sin(elapsed*10)*.38 + (game.state==='ready'?0:.16); bat.userData.wings.forEach((w,i)=>{w.rotation.z=(i?1:-1)*(.16+flap);w.rotation.x=Math.sin(elapsed*7+i)*.06;}); bat.userData.light.intensity=1.7+Math.sin(elapsed*7)*.35; }
  function updateWorld(dt){ const moved=game.distance-scrolled; scrolled=game.distance;
    tunnel.forEach(g=>{g.position.x-=moved;if(g.position.x<-16)g.position.x+=tunnel.length*8;});
    syncObstacles();
    if(Math.random()<dt*10) dustTrail();
  }
  function updateParticles(dt){particles.forEach(p=>{if(!p.mesh.visible)return;p.life-=dt;if(p.life<=0){p.mesh.visible=false;return;}p.vel.y+=p.gravity*dt;p.mesh.position.addScaledVector(p.vel,dt);p.mesh.rotation.x+=dt*4;p.mesh.material.opacity=clamp(p.life,0,1)*.65;});}
  // The model consumes frame time in fixed ticks; effects use the same clamped frame time.
  function render(now){ const dt=clock.frame(now);elapsed+=dt; const wasRunning=game.state==='running'; game.advance(dt); if(wasRunning&&game.state==='over') gameOver(); showScore(); updateBat(dt);updateWorld(dt);updateParticles(dt); shake*=Math.pow(.004,dt); placeCamera(); renderer.render(scene,camera); requestAnimationFrame(render); }
  // Fixed side view of the play plane: no height follow and no tilt, so gaps keep their screen height and pillars stay vertical.
  // The crash shake is a brief jitter (~.13 s half-life) and is off for reduced-motion users.
  function placeCamera(){ const s=reducedMotion.matches?0:shake*SHAKE_GAIN; camera.position.set(bat.position.x+view.x+Math.sin(elapsed*53)*s, view.y+Math.sin(elapsed*41+1)*s, view.distance); }
  function onResize(){ const aspect=innerWidth/innerHeight; view=frameView(aspect,CAM_FOV); camera.aspect=aspect; camera.updateProjectionMatrix(); scene.fog.density=FOG_DENSITY*FOG_REFERENCE_DISTANCE/view.distance; renderer.setPixelRatio(Math.min(devicePixelRatio,1.7)); renderer.setSize(innerWidth,innerHeight); placeCamera(); }
  bindInput({ win:window, doc:document, stage, onFlap:flap, buttons:[[startButton,flap],[restartButton,restart]] });
  addEventListener('resize',onResize); onResize();
  document.addEventListener('visibilitychange',()=>clock.reset()); // hidden time is not simulated; the run resumes where it stopped
  requestAnimationFrame(render);
})();
