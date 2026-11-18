function e = make_event(kind, x0, h, l)
% 방지턱/포트홀 하나 만들기
%   kind : 'bump'(방지턱) 또는 'pothole'(포트홀)
%   x0   : 시작 위치 (m)
%   h    : 높이 또는 깊이 (m)
%   l    : 길이 (m)
% 여러 개는 이어 붙이면 됨: ev = [make_event(...), make_event(...)];
e = struct('kind', kind, 'x0', x0, 'h', h, 'l', l);
end
