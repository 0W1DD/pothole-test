"""STL(삼각형 메시) → STEP(솔리드). 같은 평면에 있는 삼각형을 하나의 면으로 합쳐서 깔끔한 STEP으로 만듦."""
import sys, trimesh, numpy as np
from OCP.gp import gp_Pnt
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace, BRepBuilderAPI_Sewing, BRepBuilderAPI_MakeSolid
from OCP.TopoDS import TopoDS
from OCP.TopAbs import TopAbs_SHELL, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.ShapeFix import ShapeFix_Solid
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.Interface import Interface_Static
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp

def convert(src, dst):
    m = trimesh.load(src)
    m.merge_vertices(); m.update_faces(m.nondegenerate_faces())
    sew = BRepBuilderAPI_Sewing(1e-3)
    for f in m.faces:
        p = m.vertices[f]
        poly = BRepBuilderAPI_MakePolygon(*[gp_Pnt(*map(float, v)) for v in p], True)
        fa = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if fa.IsDone(): sew.Add(fa.Face())
    sew.Perform()
    sh = sew.SewedShape()
    ex = TopExp_Explorer(sh, TopAbs_SHELL)
    mk = BRepBuilderAPI_MakeSolid()
    while ex.More():
        mk.Add(TopoDS.Shell(ex.Current())); ex.Next()
    fix = ShapeFix_Solid(mk.Solid()); fix.Perform()
    solid = fix.Solid()
    u = ShapeUpgrade_UnifySameDomain(solid, True, True, True); u.Build()
    out = u.Shape()
    n = 0; ex = TopExp_Explorer(out, TopAbs_FACE)
    while ex.More(): n += 1; ex.Next()
    pr = GProp_GProps(); BRepGProp.VolumeProperties_s(out, pr)
    ok = BRepCheck_Analyzer(out).IsValid()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w = STEPControl_Writer(); w.Transfer(out, STEPControl_AsIs)
    assert w.Write(dst) == IFSelect_RetDone
    print(f"{dst}: 면 {n}개, 부피 {pr.Mass()/1000:.1f}cm3 (STL {m.volume/1000:.1f}), 유효 {ok}")

for v in ("pin", "wire"):
    for p in ("body", "lid"):
        convert(f"blackbox_{v}_{p}.stl", f"blackbox_{v}_{p}.step")
