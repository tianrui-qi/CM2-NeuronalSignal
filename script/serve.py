import hydra
import omegaconf

from src.serve import serve


@hydra.main(version_base=None, config_path="../config", config_name="serve")
def main(cfg: omegaconf.DictConfig) -> None:
    serve(**cfg)


if __name__ == "__main__": main()
