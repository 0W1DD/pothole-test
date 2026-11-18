function v = prctile_simple(x, pc)
% 백분위수 (툴박스 없이). pc = 99 이면 상위 1% 경계값
x = sort(x(:));
v = x(max(1, min(numel(x), round(pc/100 * numel(x)))));
end
