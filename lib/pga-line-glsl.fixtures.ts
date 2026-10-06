/** shaderKey of the last row of each document, recorded on main before
 *  projective geometry (docs/pga.md): a row written line(A, B) must keep
 *  drawing exactly this GLSL. */
export const LINE_GLSL: Record<string, string> = {
  'line((0, 0), (1, 2))': '["implicit2d",[],"(((x * 2.0) - y) - (0.0))",null,null,null,null]',
  'line(0, 0, 1, 2)': '["implicit2d",[],"(((x * 2.0) - y) - (0.0))",null,null,null,null]',
  'A = (-2, -1); B = (2, 1.5); line(A, B)':
    '["implicit2d",["A_x","A_y","B_x","B_y"],"((((x - u_A_x) * (u_B_y - u_A_y)) - ((y - u_A_y) * (u_B_x - u_A_x))) - (0.0))",null,null,null,null]',
  'A = (-2, -1); B = (2, 1.5); segment(A, B); M = midpoint(A, B); line(M, M + perp(B - A))':
    '["implicit2d",["A_x","A_y","B_x","B_y","M_x","M_y"],"((((x - u_M_x) * ((u_M_y + (u_B_x - u_A_x)) - u_M_y)) - ((y - u_M_y) * ((u_M_x + (-(u_B_y - u_A_y))) - u_M_x))) - (0.0))",null,null,null,null]',
  'a = 1; A = (a, 0); line(A, (0, a))':
    '["implicit2d",["A_x","A_y","a"],"((((x - u_A_x) * (u_a - u_A_y)) - ((y - u_A_y) * (-u_A_x))) - (0.0))",null,null,null,null]',
  'A = (cos(t), sin(t)); line((0, 0), A)':
    '["implicit2d",["A_x","A_y"],"(((x * u_A_y) - (y * u_A_x)) - (0.0))",null,null,null,null]',
  'P = [(1, 1), (2, 0)]; A = (0, 0); line(P, A)':
    'family:["implicit2d",["A_x","A_y","eqioFamilyIndex"],"((((x - (((u_eqioFamilyIndex < 0.5)) ? 1.0 : 2.0)) * (((u_eqioFamilyIndex < 0.5)) ? (u_A_y - 1.0) : u_A_y)) - ((((u_eqioFamilyIndex < 0.5)) ? (y - 1.0) : y) * (u_A_x - (((u_eqioFamilyIndex < 0.5)) ? 1.0 : 2.0)))) - (0.0))",null,null,null,null]|["implicit2d",["A_x","A_y","eqioFamilyIndex"],"((((x - (((u_eqioFamilyIndex < 0.5)) ? 1.0 : 2.0)) * (((u_eqioFamilyIndex < 0.5)) ? (u_A_y - 1.0) : u_A_y)) - ((((u_eqioFamilyIndex < 0.5)) ? (y - 1.0) : y) * (u_A_x - (((u_eqioFamilyIndex < 0.5)) ? 1.0 : 2.0)))) - (0.0))",null,null,null,null]',
  'k = [1, 2, 3]; line((0, 0), (1, k))':
    'family:["implicit2d",["eqioFamilyIndex"],"(((((u_eqioFamilyIndex < 0.5)) ? x : (((u_eqioFamilyIndex < 1.5)) ? (x * 2.0) : (x * 3.0))) - y) - (0.0))",null,null,null,null]|["implicit2d",["eqioFamilyIndex"],"(((((u_eqioFamilyIndex < 0.5)) ? x : (((u_eqioFamilyIndex < 1.5)) ? (x * 2.0) : (x * 3.0))) - y) - (0.0))",null,null,null,null]|["implicit2d",["eqioFamilyIndex"],"(((((u_eqioFamilyIndex < 0.5)) ? x : (((u_eqioFamilyIndex < 1.5)) ? (x * 2.0) : (x * 3.0))) - y) - (0.0))",null,null,null,null]',
};
