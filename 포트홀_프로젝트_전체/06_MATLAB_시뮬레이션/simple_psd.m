function [f, P] = simple_psd(x, fs, nfft)
% 파워 스펙트럼 밀도 (Welch 방식, Hann 창, 50% 겹침). 툴박스 없이 동작
if nargin < 3, nfft = 1024; end
x = x(:) - mean(x);
if numel(x) < nfft
    nfft = 2^floor(log2(numel(x)));
end
w = 0.5 - 0.5*cos(2*pi*(0:nfft-1)' / (nfft-1));
step = nfft / 2;
nseg = floor((numel(x) - nfft) / step) + 1;
P = zeros(nfft/2 + 1, 1);
for s = 1:nseg
    seg = x((s-1)*step + (1:nfft)) .* w;
    X = fft(seg);
    P = P + abs(X(1:nfft/2 + 1)).^2;
end
P = P / (nseg * fs * sum(w.^2));
P(2:end-1) = 2 * P(2:end-1);
f = (0:nfft/2)' * fs / nfft;
end
