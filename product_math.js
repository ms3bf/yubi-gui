// Product matrix_basis contract; all matrices in this module are Blender-space.
export function productMath(T) {
  const matrix=rows=>new T.Matrix4().set(...rows.flat());
  const trs=n=>new T.Matrix4().compose(new T.Vector3(...n.position),new T.Quaternion(...n.quaternion),new T.Vector3(...n.scale));
  function rigInfo(rig) {
    const rest=Object.fromEntries(Object.entries(rig.bones).map(([n,b])=>[n,matrix(b.rest_matrix)]));
    return {rig,rest,inverse:Object.fromEntries(Object.entries(rest).map(([n,m])=>[n,m.clone().invert()])),
      local:Object.fromEntries(Object.entries(rig.bones).map(([n,b])=>[n,b.parent?rest[b.parent].clone().invert().multiply(rest[n]):rest[n].clone()])),
      parent:(rig.parent_world?matrix(rig.parent_world):new T.Matrix4()).multiply(matrix(rig.matrix_parent_inverse))};
  }
  function forward(pose, info) {
    const root=info.parent.clone().multiply(trs(pose.wrist)), bones={};
    for(const [name,b] of Object.entries(info.rig.bones))
      bones[name]=(b.parent?bones[b.parent].clone():new T.Matrix4()).multiply(info.local[name]).multiply(trs(pose.joints[name]));
    return {root,bones};
  }
  function dual(m) {
    // Polar rotation supports non-uniform scale/shear in pose-bone matrices.
    const linear=new T.Matrix3().setFromMatrix4(m);let rot=linear.clone();
    for(let step=0;step<12;step++){
      const inv=rot.clone().invert().transpose(),a=rot.elements,b=inv.elements;let error=0;
      for(let j=0;j<9;j++){const v=.5*(a[j]+b[j]);error=Math.max(error,Math.abs(v-a[j]));a[j]=v;}
      if(error<1e-10)break;
    }
    const r=rot.elements,rm=new T.Matrix4().set(r[0],r[3],r[6],0,r[1],r[4],r[7],0,r[2],r[5],r[8],0,0,0,0,1);
    const q=new T.Quaternion().setFromRotationMatrix(rm).normalize();
    const e=m.elements,d=new T.Quaternion(e[12],e[13],e[14],0).multiply(q);
    return {q:q.toArray(),d:d.toArray().map(x=>x*.5),scale:rot.clone().transpose().multiply(linear)};
  }
  function skinCage(mesh,pose,info,mode='dual') {
    const fk=forward(pose,info), transforms=mesh.bones.map(n=>fk.bones[n].clone().multiply(info.inverse[n]));
    const ds=mode==='dual'?transforms.map(dual):null;
    return mesh.points.map((p,i)=>{
      const v=new T.Vector3(...p),weights=mesh.weights[i];let out=new T.Vector3();
      if(mode==='linear')for(const [n,w] of weights)out.addScaledVector(v.clone().applyMatrix4(transforms[n]),w);
      else {
        const q=[0,0,0,0],d=[0,0,0,0],ref=ds[weights[0][0]].q;const scaled=new T.Vector3();
        for(const [n,w] of weights){
          const a=ds[n],sign=a.q.reduce((s,x,j)=>s+x*ref[j],0)<0?-1:1;
          for(let j=0;j<4;j++){q[j]+=a.q[j]*w*sign;d[j]+=a.d[j]*w*sign;}
          scaled.addScaledVector(v.clone().applyMatrix3(a.scale),w);
        }
        const norm=Math.hypot(...q);const real=new T.Quaternion(...q.map(x=>x/norm));
        const displacement=new T.Quaternion(...d.map(x=>x/norm)).multiply(real.clone().conjugate());
        out=scaled.applyQuaternion(real).add(new T.Vector3(displacement.x,displacement.y,displacement.z).multiplyScalar(2));
      }
      return out.applyMatrix4(fk.root).toArray();
    });
  }
  return {matrix,trs,rigInfo,forward,skinCage};
}
