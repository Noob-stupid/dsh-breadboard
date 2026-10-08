import * as THREE from "three"
const scene = new THREE.Scene()
const geo = new THREE.CylinderGeometry(1, 1, 0.12, 16)
const mat = new THREE.MeshBasicMaterial()
const hidden = new THREE.Mesh(geo, mat)
hidden.visible = false
hidden.userData = { componentId: "c1", portId: "P1" }
scene.add(hidden)
const shown = new THREE.Mesh(geo, mat)
shown.position.set(5, 0, 0)
scene.add(shown)
scene.updateMatrixWorld(true)   // ★ 上一条漏了这行，导致"可见的也没命中"

const rc = new THREE.Raycaster()
const shoot = (x) => { rc.set(new THREE.Vector3(x, 5, 0), new THREE.Vector3(0, -1, 0)); return rc.intersectObject(scene, true) }
const a = shoot(0), b = shoot(5)
console.log("three r" + THREE.REVISION)
console.log("射线打在【不可见】mesh 上:", a.length, a.length ? "→ 命中，userData=" + JSON.stringify(a[0].object.userData) : "")
console.log("射线打在【可见】  mesh 上:", b.length)
const grp = new THREE.Group(); grp.visible = false; grp.add(hidden.clone())
const s2 = new THREE.Scene(); s2.add(grp); s2.updateMatrixWorld(true)
rc.set(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0))
console.log("父级 Group 不可见、子 mesh visible=true:", rc.intersectObject(s2, true).length)
