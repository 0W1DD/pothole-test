function tdet = detect_events(t, score, th, cooldown)
% 감지 규칙 (pothole_detect.py 와 같음):
%   점수가 th 를 넘고, 마지막 감지 후 cooldown 초가 지났으면 감지
% 돌려주는 값: 감지된 시각들 (s)
tdet = zeros(0, 1);
i0 = 1;
while true
    j = find(score(i0:end) > th, 1);
    if isempty(j), break; end
    j = j + i0 - 1;
    tdet(end+1, 1) = t(j); %#ok<AGROW>
    i0 = find(t > t(j) + cooldown, 1);
    if isempty(i0), break; end
end
end
