function [x, z] = make_road(p, dur, events, seed)
% 노면 높이 만들기
%   x : 위치 (m),  z : 높이 (m)
%   events : 방지턱/포트홀 목록 (make_event 로 만든 구조체 배열, 없으면 [])
%   seed   : 난수 시드 (같은 값이면 같은 노면)

rs = RandStream('mt19937ar', 'Seed', seed);
dx = 0.005;                                  % 5 mm 간격
x = (-2 : dx : p.v*dur + 5)';

% 1) 평소 노면의 자잘한 굴곡: ISO 8608 스펙트럼을 사인파 400개로 합성
n  = logspace(log10(p.nmin), log10(p.nmax), 400);   % 공간 주파수 (cycle/m)
dn = gradient(n);
G  = p.Gd * (n / 0.1).^(-2);                         % 거칠기 스펙트럼
A  = sqrt(2 * G .* dn);                              % 각 사인파 진폭
ph = 2*pi*rand(rs, 1, numel(n));                     % 무작위 위상
z = zeros(size(x));
for i = 1:numel(n)
    z = z + A(i) * sin(2*pi*n(i)*x + ph(i));
end

% 2) 방지턱(반 사인 모양), 포트홀(사각 구멍) 더하기
for k = 1:numel(events)
    e = events(k);
    m = (x >= e.x0) & (x <= e.x0 + e.l);
    switch e.kind
        case 'bump'
            z(m) = z(m) + e.h * sin(pi * (x(m) - e.x0) / e.l);
        case 'pothole'
            % 구멍이 짧으면 바퀴가 바닥까지 못 빠짐 (바퀴 반지름 R)
            d_eff = p.R - sqrt(max(p.R^2 - (e.l/2)^2, 0));
            z(m) = z(m) - min(e.h, d_eff);
    end
end

% 3) 타이어 접지 길이만큼 뭉개기 (타이어는 날카로운 모서리를 둥글게 받아들임)
k = max(1, round(p.contact / dx));
z = movmean(z, k);
end
