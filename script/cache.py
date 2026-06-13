import hydra
import omegaconf

from src.cache.builder import build_cache


@hydra.main(version_base=None, config_path="../config", config_name="cache")
def main(cfg: omegaconf.DictConfig) -> None:
    build_cache(**cfg)


if __name__ == "__main__": main()
