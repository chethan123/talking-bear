import { WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, AmbientLight, AnimationMixer, Clock } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const r = new WebGLRenderer({ antialias: true }); document.body.appendChild(r.domElement);
const s = new Scene(); const c = new PerspectiveCamera(35, 1, 0.1, 100);
s.add(new AmbientLight(0xffffff, 1), new DirectionalLight(0xffffff, 2));
const mixer = { m: null }; const clock = new Clock();
new GLTFLoader().load('bear.glb', g => { s.add(g.scene); mixer.m = new AnimationMixer(g.scene); g.scene.traverse(o => { if (o.morphTargetInfluences) o.morphTargetInfluences[0] = 0.5; }); });
r.setAnimationLoop(() => { mixer.m && mixer.m.update(clock.getDelta()); r.render(s, c); });
