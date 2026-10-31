/* Flappy Bat — procedural Three.js game, no build step required. */
import { bindInput } from './input.mjs';
import { frameView } from './view.mjs';
import {
  BAT_BODY_RADIUS, BAT_BODY_SCALE, BAT_HALF_HEIGHT, BAT_HALF_WIDTH, BAT_MODEL_YAW, BAT_START_Y, BAT_X, CAVE_FLOOR, bodyPitch,
} from './game-rules.mjs';
import { OBSTACLE_COUNT, createFrameClock, createGame, startRun } from './game-core.mjs';
import { obstacleParts } from './collision.mjs';
import { MAX_SEED, parseSeed, randomSeed } from './obstacle-generator.mjs';
import { TUNNEL_SEGMENT_LENGTH, pillarMesh, tunnelSections, tunnelSegmentMesh } from './rock-mesh.mjs';

(() => {
  'use strict';
  const THREE = window.THREE;
  if (!THREE) return;

  const $ = (id) => document.getElementById(id);
  const stage = $('game'), sceneHost = $('scene'), scoreEl = $('score'), bestEl = $('best');
  const overlay = $('overlay'), message = $('message'), startButton = $('startButton');
  const restartButton = $('restartButton'), touchHint = $('touchHint');
  const MAX_PARTICLES = 230;
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

  // The body uses the size and turn that define the collision ellipse in game-rules.mjs; the head, ears and wings are not part of it.
  function makeBat() {
    const outer = new THREE.Group(); outer.position.set(BAT_X, BAT_START_Y, 0);
    const root = new THREE.Group(); root.rotation.y = BAT_MODEL_YAW; outer.add(root); // model faces -z; turn it to face +x
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(BAT_BODY_RADIUS, 1), batMat); body.scale.set(...BAT_BODY_SCALE); body.castShadow = true; root.add(body);
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

  function meshGeometry({ positions, indices }) { const geom=new THREE.BufferGeometry(); geom.setAttribute('position',new THREE.Float32BufferAttribute(positions,3)); geom.setIndex(indices); geom.computeVertexNormals(); return geom; }
  const rimMat = new THREE.MeshStandardMaterial({ color:0x221b20, roughness:.98, flatShading:true, side:THREE.DoubleSide });
  // Cave segments from rock-mesh.mjs: the floor and ceiling rims are creases on the play plane at the collision surfaces.
  // The open side faces the camera at +z; only the cliffs below the floor and above the ceiling reach toward it.
  // Segment i ends on the section where segment i + 1 starts, also when the first segment moves behind the last.
  const TUNNEL_SEGMENTS = 18, tunnelSectionRing = tunnelSections(TUNNEL_SEGMENTS, Math.random);
  function makeTunnelSegment(i) {
    const group = new THREE.Group(); group.position.x = i * TUNNEL_SEGMENT_LENGTH - 16;
    const data = tunnelSegmentMesh(tunnelSectionRing[i], tunnelSectionRing[(i + 1) % TUNNEL_SEGMENTS], Math.random);
    const mesh=new THREE.Mesh(meshGeometry(data), choose(rockMats)); mesh.receiveShadow=true; group.add(mesh);
    group.add(new THREE.Mesh(meshGeometry({ positions:data.positions, indices:data.rimIndices }), rimMat));
    data.pebbles.forEach((p) => { const pebble=new THREE.Mesh(new THREE.DodecahedronGeometry(p.radius,0),choose(rockMats)); pebble.position.set(p.x,p.y,p.z); pebble.rotation.set(...p.rotation); group.add(pebble); });
    return group;
  }
  const tunnel = Array.from({length:TUNNEL_SEGMENTS}, (_,i) => { const g=makeTunnelSegment(i); scene.add(g); return g; });

  // Pillar part from its collision outline (obstacleParts), so the drawn edge is the edge the body hits.
  function makePillarPart(part) {
    const data = pillarMesh(part, Math.random), group = new THREE.Group();
    const mesh = new THREE.Mesh(meshGeometry(data), choose(rockMats)); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
    data.stones.forEach((st) => { const stone=new THREE.Mesh(new THREE.DodecahedronGeometry(st.radius,0),choose(rockMats)); stone.position.set(st.x,st.y,st.z); stone.scale.y=st.scaleY; stone.rotation.set(...st.rotation); group.add(stone); });
    return group;
  }
  function makeObstacle() { const g=new THREE.Group(); scene.add(g); return g; }
  // Rebuilds an obstacle's pillars around the model outline at x = 0; syncObstacles moves the group to the model x.
  function shapeObstacle(g, d) {
    g.children.forEach((part) => part.traverse((o) => { if (o.geometry) o.geometry.dispose(); }));
    g.clear();
    obstacleParts({ ...d, x: 0 }).forEach((part) => g.add(makePillarPart(part)));
    g.userData.shape = shapeKey(d);
  }
  const shapeKey = (d) => `${d.gapY}|${d.gapHeight}|${d.halfWidth}`;
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
  // Every run draws a new obstacle seed; `?seed=N` replays the layout of seed N in every run. Obstacles use
  // only their seed, so the Math.random calls of rocks, materials and particles never change them.
  const seedParam=new URLSearchParams(location.search).get('seed'), fixedSeed=parseSeed(seedParam);
  if(seedParam!==null&&fixedSeed===null) console.warn(`Ignored seed "${seedParam}": use an integer from 0 to ${MAX_SEED}.`);
  const game=createGame({ seed:fixedSeed ?? randomSeed }), clock=createFrameClock();
  let best=readBestScore(), elapsed=0, shake=0, fallVelocity=0, restY=CAVE_FLOOR, shownScore=0, scrolled=0;
  const crashPoint = new THREE.Vector3();
  bestEl.textContent=best;
  function showScore(){ if(game.score===shownScore) return; shownScore=game.score; scoreEl.textContent=shownScore; }
  function syncObstacles(){ obstacles.forEach((o,i)=>{ const d=game.obstacles[i]; if(o.userData.shape!==shapeKey(d)) shapeObstacle(o,d); o.position.x=d.x; }); }
  // Centre height where the falling bat comes to rest after a crash: on the floor, or on a lower pillar right under it.
  function restHeight(){ let surface=CAVE_FLOOR; game.obstacles.forEach((o)=>obstacleParts(o).forEach((p)=>{ if(p.side==='lower'&&p.edgeY<game.bat.y&&p.edgeY>surface&&Math.abs(p.x-game.bat.x)<p.halfWidth+BAT_HALF_WIDTH) surface=p.edgeY; })); return surface+BAT_HALF_HEIGHT; }
  function clearEffects(){ shake=0; fallVelocity=0; bat.rotation.z=0; particles.forEach(p=>{p.life=0;p.mesh.visible=false;}); }
  function setReady(){ game.reset(); clearEffects(); scrolled=0; showScore(); bat.position.set(BAT_X,BAT_START_Y,0);message.textContent='';showScreen('ready'); }
  function start(){ if(!startRun(game,clock)) return; showScreen('running'); }
  // Runs once when the model reports a crash. The bat is shown in the pose that touched (model position and tilt),
  // and the dust bursts from the touched point. Then come the best score and the over screen.
  function gameOver(){ shake=.62; fallVelocity=game.bat.velocity; restY=Math.min(restHeight(),game.bat.y); bat.position.y=game.bat.y; bat.rotation.z=bodyPitch(game.bat.velocity); crashPoint.set(game.crash.x,game.crash.y,0); burst(crashPoint,38,0xd87554,3.2); burst(crashPoint,26,0x8c6570,2.2); const record=game.score>best; if(record){best=game.score;writeBestScore(best);bestEl.textContent=best;} showScreen('over'); showResult(record); }
  function restart(){ setReady(); start(); }
  // `ready` shows the start guide and `over` a compact crash result. While running, the overlay fades out
  // as an inert, pointer-transparent layer, so taps reach the stage and hidden buttons keep no focus.
  function showScreen(phase){ const running=phase==='running'; if(!running) overlay.dataset.phase=phase; overlay.classList.toggle('hidden',running); overlay.inert=running; touchHint.classList.toggle('off',phase!=='ready'); if(running&&overlay.contains(document.activeElement)) document.activeElement.blur(); }
  // The seed lets a player report the run; `?seed=<seed>` replays its obstacles.
  function showResult(record){ message.innerHTML=`<span class="result-label">통과한 기둥</span><strong class="result-score">${game.score}</strong><span class="result-best${record?' record':''}">${record?'새 최고 기록!':`최고 기록 ${best}`}</span><span class="result-seed">SEED ${game.seed}</span>`; }
  function flap(){ if(game.state==='ready') start(); else if(game.state==='over'){setReady();start();} else game.flap(); }
  // While running the bat shows exactly the model pose that collision tests: centre height and bodyPitch tilt.
  // After a crash it falls as an effect and stops on the floor or the lower pillar under it.
  function updateBat(dt){ if(game.state==='running'){bat.position.y=game.bat.y; bat.rotation.z=bodyPitch(game.bat.velocity);}
    else { if(game.state==='ready'){bat.position.y=game.bat.y+Math.sin(elapsed*2.1)*.12;} else { fallVelocity-=7*dt; bat.position.y+=fallVelocity*dt; if(bat.position.y<=restY){bat.position.y=restY; fallVelocity=0;} bat.rotation.z+=dt*2.5; }
      bat.rotation.z += (bodyPitch(game.state==='over'?fallVelocity:0)-bat.rotation.z)*Math.min(dt*8,1); }
    const flap=game.state==='over'?0:Math.sin(elapsed*10)*.38 + (game.state==='ready'?0:.16); bat.userData.wings.forEach((w,i)=>{w.rotation.z=(i?1:-1)*(.16+flap);w.rotation.x=Math.sin(elapsed*7+i)*.06;}); bat.userData.light.intensity=1.7+Math.sin(elapsed*7)*.35; }
  function updateWorld(dt){ const moved=game.distance-scrolled; scrolled=game.distance;
    tunnel.forEach(g=>{g.position.x-=moved;if(g.position.x<-16)g.position.x+=tunnel.length*TUNNEL_SEGMENT_LENGTH;});
    syncObstacles();
    if(Math.random()<dt*10) dustTrail();
  }
  function updateParticles(dt){particles.forEach(p=>{if(!p.mesh.visible)return;p.life-=dt;if(p.life<=0){p.mesh.visible=false;return;}p.vel.y+=p.gravity*dt;p.mesh.position.addScaledVector(p.vel,dt);p.mesh.rotation.x+=dt*4;p.mesh.material.opacity=clamp(p.life,0,1)*.65;});}
  // The model consumes frame time in fixed ticks; effects use the same clamped frame time.
  // The crash frame does not move the bat, so the first over frame shows the touching pose.
  function render(now){ const dt=clock.frame(now);elapsed+=dt; const wasRunning=game.state==='running'; game.advance(dt); const crashed=wasRunning&&game.state==='over'; if(crashed) gameOver(); showScore(); updateBat(crashed?0:dt);updateWorld(dt);updateParticles(dt); shake*=Math.pow(.004,dt); placeCamera(); renderer.render(scene,camera); requestAnimationFrame(render); }
  // Fixed side view of the play plane: no height follow and no tilt, so gaps keep their screen height and pillars stay vertical.
  // The crash shake is a brief jitter (~.13 s half-life) and is off for reduced-motion users.
  function placeCamera(){ const s=reducedMotion.matches?0:shake*SHAKE_GAIN; camera.position.set(bat.position.x+view.x+Math.sin(elapsed*53)*s, view.y+Math.sin(elapsed*41+1)*s, view.distance); }
  function onResize(){ const aspect=innerWidth/innerHeight; view=frameView(aspect,CAM_FOV); camera.aspect=aspect; camera.updateProjectionMatrix(); scene.fog.density=FOG_DENSITY*FOG_REFERENCE_DISTANCE/view.distance; renderer.setPixelRatio(Math.min(devicePixelRatio,1.7)); renderer.setSize(innerWidth,innerHeight); placeCamera(); }
  bindInput({ win:window, doc:document, stage, onFlap:flap, buttons:[[startButton,flap],[restartButton,restart]] });
  addEventListener('resize',onResize); onResize();
  document.addEventListener('visibilitychange',()=>clock.reset()); // hidden time is not simulated; the run resumes where it stopped
  requestAnimationFrame(render);
})();
