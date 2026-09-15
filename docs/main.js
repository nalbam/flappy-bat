/* Flappy Bat — procedural Three.js game, no build step required. */
(() => {
  'use strict';
  const THREE = window.THREE;
  if (!THREE) return;

  const $ = (id) => document.getElementById(id);
  const sceneHost = $('scene'), scoreEl = $('score'), bestEl = $('best');
  const overlay = $('overlay'), message = $('message'), startButton = $('startButton');
  const restartButton = $('restartButton'), touchHint = $('touchHint');
  const TAU = Math.PI * 2, MAX_PARTICLES = 230;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const choose = (a) => a[Math.floor(Math.random() * a.length)];

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171116);
  scene.fog = new THREE.FogExp2(0x171116, 0.027);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, .1, 130);
  camera.position.set(0, 2.7, 8.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sceneHost.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0x776b76, 0x181117, 1.2));
  const ambient = new THREE.AmbientLight(0x372d3a, .75); scene.add(ambient);
  const moon = new THREE.DirectionalLight(0xaaa0c5, 1.4); moon.position.set(-8, 12, 4); scene.add(moon);
  const caveLight = new THREE.PointLight(0x743e36, 2.5, 21, 2); caveLight.position.set(0, -1, 2); scene.add(caveLight);

  const rockMats = [0x403b3d, 0x51474a, 0x625052, 0x352f35, 0x6a5753].map((c, i) => new THREE.MeshStandardMaterial({ color:c, roughness:.96, metalness:.02, flatShading:true, emissive:i === 2 ? 0x100b0d : 0x000000, emissiveIntensity:.4 }));
  const batMat = new THREE.MeshStandardMaterial({ color:0x332332, roughness:.75, flatShading:true });
  const batWingMat = new THREE.MeshStandardMaterial({ color:0x734454, roughness:.84, side:THREE.DoubleSide, flatShading:true });
  const eyeMat = new THREE.MeshBasicMaterial({ color:0xf5ae67 });
  const dustMat = new THREE.MeshBasicMaterial({ color:0xc18f75, transparent:true, opacity:.42 });

  function makeBat() {
    const root = new THREE.Group(); root.position.set(0, 2.2, 0);
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
    const left = wingShape(-1), right = wingShape(1); root.userData.wings = [left,right];
    const glow = new THREE.PointLight(0xd17c59, 1.8, 4.5, 2); glow.position.set(0,.2,.15); root.add(glow); root.userData.light = glow;
    return root;
  }
  const bat = makeBat(); scene.add(bat);

  function makeTunnelSegment(i) {
    const group = new THREE.Group(); group.position.z = -i * 8;
    const n=14, rings=2, verts=[], indices=[];
    for (let r=0;r<rings;r++) for (let j=0;j<n;j++) { const a=j/n*TAU; const radius=5.0 + rand(-.35,.35) + Math.sin(j*2.1+i)*.18; verts.push(Math.cos(a)*radius, Math.sin(a)*radius+1.3, r*8-4); }
    for (let j=0;j<n;j++) { const a=j, b=(j+1)%n; indices.push(a,b,n+b, a,n+b,n+a); }
    const geom=new THREE.BufferGeometry(); geom.setAttribute('position',new THREE.Float32BufferAttribute(verts,3)); geom.setIndex(indices); geom.computeVertexNormals();
    const mesh=new THREE.Mesh(geom, choose(rockMats)); mesh.receiveShadow=true; group.add(mesh);
    for (let j=0;j<3;j++) { const pebble=new THREE.Mesh(new THREE.DodecahedronGeometry(rand(.12,.33),0),choose(rockMats)); const a=rand(0,TAU), r=rand(4.75,5.15); pebble.position.set(Math.cos(a)*r,1.3+Math.sin(a)*r,rand(-3.8,3.8)); pebble.rotation.set(rand(0,TAU),rand(0,TAU),rand(0,TAU)); group.add(pebble); }
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
  function makeObstacle(i) { const g=new THREE.Group(); g.userData.index=i; g.userData.active=false; g.add(pillarPart(4.2,3.7,rand(.1,.9)),pillarPart(4.2,-3.7,rand(.1,.9))); scene.add(g); return g; }
  const obstacles=Array.from({length:9},(_,i)=>makeObstacle(i));

  const particleGeo = new THREE.IcosahedronGeometry(.045,0);
  const particles=[];
  for(let i=0;i<MAX_PARTICLES;i++){ const m=new THREE.Mesh(particleGeo,dustMat); m.visible=false; scene.add(m); particles.push({mesh:m,life:0,vel:new THREE.Vector3(),gravity:-2}); }
  function burst(pos,count,color,force=.8){ for(let k=0;k<count;k++){ const p=particles.find(x=>!x.mesh.visible); if(!p) break; p.mesh.material=color ? new THREE.MeshBasicMaterial({color,transparent:true,opacity:.8}) : dustMat; p.mesh.visible=true; p.life=rand(.35,1.2); p.mesh.scale.setScalar(rand(.5,1.8)); p.mesh.position.copy(pos); p.vel.set(rand(-1,1),rand(-.1,1.4),rand(-1,1)).normalize().multiplyScalar(rand(.2,force)); } }
  function dustTrail(){ const p=particles.find(x=>!x.mesh.visible); if(!p) return; p.mesh.material=dustMat;p.mesh.visible=true;p.life=rand(.7,1.8);p.mesh.position.set(rand(-4,4),rand(-2,6),rand(-35,4));p.vel.set(0,rand(-.1,.1),rand(.3,.8));p.gravity=0; }

  let state='ready', score=0, best=Number(localStorage.getItem('flappyBatBest')||0), velocity=0, elapsed=0, runTime=0, spawnZ=-26, shake=0, last=performance.now();
  bestEl.textContent=best;
  function resetObstacles(){ obstacles.forEach((o,i)=>{o.position.z=-18-i*19;o.userData.active=i<7;o.userData.passed=false;o.userData.gap=rand(-.7,1.8);o.userData.spin=rand(-.5,.5); o.position.y=o.userData.gap; }); }
  resetObstacles();
  function setReady(){ state='ready'; score=0;scoreEl.textContent='0';velocity=0;runTime=0;bat.position.set(0,2.2,0);overlay.classList.remove('hidden');overlay.classList.add('ready');message.innerHTML='동굴 사이를 날아<br />최고 점수를 기록하세요.';startButton.innerHTML='날아오르기 <span>SPACE</span>';restartButton.classList.remove('visible');touchHint.classList.remove('off');resetObstacles(); }
  function start(){ if(state==='running') return; state='running';overlay.classList.add('hidden');restartButton.classList.remove('visible');touchHint.classList.add('off'); velocity=2.25; }
  function gameOver(){ if(state!=='running') return; state='over'; shake=.62; burst(bat.position,38,0xd87554,3.2); burst(bat.position,26,0x8c6570,2.2); if(score>best){best=score;localStorage.setItem('flappyBatBest',String(best));bestEl.textContent=best;} message.innerHTML=`비행 기록 <strong>${score}</strong><br />조금 더 멀리 날아볼까요?`;startButton.textContent='다시 날기';overlay.classList.remove('hidden');restartButton.classList.add('visible');touchHint.classList.add('off'); }
  function flap(){ if(state==='ready') start(); else if(state==='over'){setReady();start();} else velocity=5.1; }
  function updateBat(dt){ if(state==='ready'){bat.position.y=2.2+Math.sin(elapsed*2.1)*.12;} else if(state==='running'){velocity-=10.4*dt;bat.position.y+=velocity*dt; if(bat.position.y>5.5||bat.position.y<-.8) gameOver(); } else { velocity-=7*dt;bat.position.y+=velocity*dt; bat.rotation.z+=dt*2.5; }
    const pitch=clamp(velocity*.045,-.34,.32); bat.rotation.z += (pitch-bat.rotation.z)*Math.min(dt*8,1); const flap=state==='over'?0:Math.sin(elapsed*10)*.38 + (state==='ready'?0:.16); bat.userData.wings.forEach((w,i)=>{w.rotation.z=(i?1:-1)*(.16+flap);w.rotation.x=Math.sin(elapsed*7+i)*.06;}); bat.userData.light.intensity=1.7+Math.sin(elapsed*7)*.35; }
  function updateWorld(dt){ const speed=state==='running'?7.2+Math.min(runTime*.19,6):0; if(state==='running') runTime+=dt;
    tunnel.forEach(g=>{g.position.z+=speed*dt;if(g.position.z>9)g.position.z-=tunnel.length*8;});
    if(state==='running') obstacles.forEach(o=>{o.position.z+=speed*dt;o.rotation.y+=o.userData.spin*dt; if(o.position.z>9){o.position.z-=obstacles.length*19;o.position.y=rand(-.4,1.8);o.userData.gap=o.position.y;o.userData.passed=false;o.userData.active=true;} const dz=Math.abs(o.position.z); const dy=Math.abs(bat.position.y-o.position.y); if(dz<1.05 && (dy>1.55)) gameOver(); if(!o.userData.passed&&o.position.z>1){o.userData.passed=true;score++;scoreEl.textContent=score;} });
    if(Math.random()<dt*10) dustTrail();
  }
  function updateParticles(dt){particles.forEach(p=>{if(!p.mesh.visible)return;p.life-=dt;if(p.life<=0){p.mesh.visible=false;return;}p.vel.y+=p.gravity*dt;p.mesh.position.addScaledVector(p.vel,dt);p.mesh.rotation.x+=dt*4;p.mesh.material.opacity=clamp(p.life,0,1)*.65;});}
  function render(now){ const dt=Math.min((now-last)/1000,.04);last=now;elapsed+=dt; updateBat(dt);updateWorld(dt);updateParticles(dt); shake*=Math.pow(.035,dt); const targetY=bat.position.y+1.0; camera.position.y+=(targetY-camera.position.y)*Math.min(dt*3.4,1); camera.position.x+=(Math.sin(elapsed*1.4)*shake-camera.position.x)*Math.min(dt*10,1); camera.lookAt(0,bat.position.y+.1,-9); renderer.render(scene,camera); requestAnimationFrame(render); }
  function onResize(){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));}
  startButton.addEventListener('click',flap); restartButton.addEventListener('click',()=>{setReady();});
  addEventListener('keydown',e=>{if(e.code==='Space'||e.code==='ArrowUp'){e.preventDefault();flap();}}); renderer.domElement.addEventListener('pointerdown',e=>{if(e.button===0)flap();}); addEventListener('resize',onResize);
  requestAnimationFrame(render);
})();
